import {BridgeError} from './errors.mjs';
// Only the canonical final.content string is publishable before terminal validation.
// Arguments and noncanonical envelopes stay private until the entire batch validates.
export class FinalTextProjector {
  constructor(send,{enabled=true}={}){this.send=send;this.enabled=enabled;this.source='';this.at=null;this.decoded='';this.emitted='';this.closed=false;this.broken=false;}
  push(delta){
    this.source+=delta;if(!this.enabled||this.closed||this.broken)return;
    if(this.at===null){const start=/^\s*\{\s*"action"\s*:\s*"final"\s*,\s*"content"\s*:\s*"/.exec(this.source);if(!start)return;this.at=start[0].length;}
    while(this.at<this.source.length){
      const c=this.source[this.at];if(c==='"'){this.closed=true;this.at++;break;}
      if(c!=='\\'){if(c.charCodeAt(0)<32){this.broken=true;break;}this.decoded+=c;this.at++;continue;}
      if(this.at+1>=this.source.length)break;const e=this.source[this.at+1];
      if(e==='u'){if(this.at+6>this.source.length)break;const hex=this.source.slice(this.at+2,this.at+6);if(!/^[\da-f]{4}$/i.test(hex)){this.broken=true;break;}this.decoded+=String.fromCharCode(parseInt(hex,16));this.at+=6;}
      else{const escapes={'"':'"','\\':'\\','/':'/',n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'};if(!Object.hasOwn(escapes,e)){this.broken=true;break;}this.decoded+=escapes[e];this.at+=2;}
    }
    // Markup at the beginning may be an incorrectly wrapped tool envelope.
    // Keep that answer private for full protocol validation, including split markers.
    if(this.decoded.trimStart().startsWith('<')||!this.decoded.trim())return;
    let text=this.decoded;if(!this.closed&&/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
    const next=text.slice(this.emitted.length);if(next){this.send(next);this.emitted=text;}
  }
  finish(decision){
    if(this.emitted&&(decision.action!=='final'||!decision.content.startsWith(this.emitted)))throw new BridgeError(502,'ambiguous_decision','Streamed text conflicts with validated decision');
    if(decision.action==='final'){const tail=decision.content.slice(this.emitted.length);if(tail)this.send(tail);this.emitted=decision.content;}
  }
}
