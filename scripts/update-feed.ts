import {createPublicKey,verify} from 'node:crypto';
import {desktopReleaseSchema} from '../src/delivery/desktop-update.ts';
const xml=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function updateFeed(metadata:unknown,url:string,archive:Buffer,signature:Buffer,publicKey:string){
 const release=desktopReleaseSchema.parse(metadata),download=new URL(url);
 if(download.username||download.password||download.origin!=='https://github.com'||!download.pathname.startsWith('/qoopia/qoopia-downloads/releases/download/')||!download.pathname.endsWith('.dmg')||download.search||download.hash)throw new Error('Use the exact public Qoopia release DMG URL');
 const key=createPublicKey(publicKey).export({format:'jwk'});if(!key.x||Buffer.from(key.x,'base64url').toString('base64')!==release.public_ed_key)throw new Error('Update public key does not match app metadata');
 if(!verify(null,archive,publicKey,signature))throw new Error('Update signature does not match publisher');
 return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Qoopia for Mac</title><link>https://qoopia.ai</link><description>Qoopia updates</description><language>en</language><item><title>Qoopia ${xml(release.version)}</title><sparkle:version>${release.build}</sparkle:version><sparkle:shortVersionString>${xml(release.version)}</sparkle:shortVersionString><sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion><enclosure url="${xml(url)}" length="${archive.length}" type="application/octet-stream" sparkle:edSignature="${signature.toString('base64')}"/></item></channel></rss>\n`;
}
