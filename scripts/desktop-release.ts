import {createPublicKey} from 'node:crypto';
import {desktopReleaseSchema} from '../src/delivery/desktop-update.ts';
export function desktopRelease(publicPem:string,build:number){
 const key=createPublicKey(publicPem);if(key.asymmetricKeyType!=='ed25519')throw new Error('Desktop updates require the publisher Ed25519 key');
 const jwk=key.export({format:'jwk'});if(!jwk.x)throw new Error('Publisher public key missing');
 return desktopReleaseSchema.parse({format:'qoopia-desktop-release/1',build,version:'5.0.1',public_ed_key:Buffer.from(jwk.x,'base64url').toString('base64'),feed_url:'https://qoopia.ai/updates/macos/appcast.xml'});
}
