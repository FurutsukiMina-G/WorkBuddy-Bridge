import {BridgeError} from './errors.mjs';
const ESCAPES={'"':'"','\\':'\\','/':'/',n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'};
// Only the canonical final.content string is publishable before terminal validation.
// Arguments and noncanonical envelopes stay private until the entire batch validates.
// Each chunk is decoded once from the unconsumed tail, so long answers stay linear.
export class FinalTextProjector {
  constructor(send,{enabled=true}={}){this.send=send;this.enabled=enabled;this.source='';this.significant=0;this.at=null;this.rest='';this.held='';this.lead=null;this.emitted='';this.closed=false;this.broken=false;}
  push(delta){
    if(!this.enabled||this.closed||this.broken)return;
    if(this.at===null){
      this.source+=delta;this.significant+=delta.replace(/\s+/g,'').length;
      const start=/^\s*\{\s*"action"\s*:\s*"final"\s*,\s*"content"\s*:\s*"/.exec(this.source);
      // The canonical opening has 29 non-blank characters. Once that many arrived without it,
      // this output can no longer become a streamable final answer.
      if(!start){if(this.significant>=29)this.broken=true;return;}
      this.at=start[0].length;this.rest=this.source.slice(this.at);this.source='';
    }else this.rest+=delta;
    const s=this.rest;let i=0,out='';
    while(i<s.length){
      const c=s[i];if(c==='"'){this.closed=true;i++;break;}
      // The terminal parser escapes raw string controls losslessly. Project the
      // same literal newline/tab now, instead of abandoning an otherwise final reply.
      if(c!=='\\'){out+=c;i++;continue;}
      if(i+1>=s.length)break;const e=s[i+1];
      if(e==='u'){if(i+6>s.length)break;const hex=s.slice(i+2,i+6);if(!/^[\da-f]{4}$/i.test(hex)){this.broken=true;break;}out+=String.fromCharCode(parseInt(hex,16));i+=6;}
      else{if(!Object.hasOwn(ESCAPES,e)){this.broken=true;break;}out+=ESCAPES[e];i+=2;}
    }
    this.rest=s.slice(i);this.held+=out;
    // Markup at the beginning may be an incorrectly wrapped tool envelope.
    // Keep that answer private for full protocol validation, including split markers.
    if(this.lead===null){const at=this.held.search(/\S/);if(at<0)return;this.lead=this.held[at]==='<'?'markup':'text';}
    if(this.lead==='markup')return;
    let text=this.held,keep='';if(!this.closed&&/[\uD800-\uDBFF]/.test(text.at(-1)??'')){keep=text.slice(-1);text=text.slice(0,-1);}
    if(text){this.send(text);this.emitted+=text;}this.held=keep;
  }
  finish(decision){
    if(this.emitted&&(decision.action!=='final'||!decision.content.startsWith(this.emitted)))throw new BridgeError(502,'ambiguous_decision','Streamed text conflicts with validated decision');
    if(decision.action==='final'){const tail=decision.content.slice(this.emitted.length);if(tail)this.send(tail);this.emitted=decision.content;}
  }
}
