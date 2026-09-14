import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {CompactEncrypt, CompactSign, compactDecrypt, compactVerify, exportJWK, generateKeyPair, importJWK, SignJWT, jwtVerify} from 'jose';
import {z} from 'zod';

export const BRIDGE_RELAY = 'https://auth.qoopia.ai/bridge';
export const MAX_FILE = 1024 * 1024;
export const MAX_PACKET = 3 * 1024 * 1024;
export const MAX_RPC = 5 * 1024 * 1024;
export const id = z.string().uuid();
export const fingerprint = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const label = z.string().trim().min(1).max(120).refine(s=>!/\p{Cc}/u.test(s));
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signingKey = z.object({kty:z.literal('OKP'),crv:z.literal('Ed25519'),x:coordinate}).strict();
const encryptionKey = z.object({kty:z.literal('EC'),crv:z.literal('P-256'),x:coordinate,y:coordinate}).strict();
export const publicIdentity = z.object({sign:signingKey,encrypt:encryptionKey}).strict();
export type PublicIdentity = z.infer<typeof publicIdentity>;
export type Identity = PublicIdentity & {signPrivate:ReturnType<typeof signingKey.parse>&{d:string};encryptPrivate:ReturnType<typeof encryptionKey.parse>&{d:string}};
export const sha = (bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('base64url');
export const peerId = (keys:PublicIdentity)=>sha(JSON.stringify(publicIdentity.parse({sign:keys.sign,encrypt:keys.encrypt})));
export const secret = ()=>randomBytes(32).toString('base64url');
const encode = (value:unknown)=>new TextEncoder().encode(JSON.stringify(value));

/** Standard JOSE primitives; private keys never leave their installation. */
export async function newIdentity():Promise<Identity> {
  const sign=await generateKeyPair('Ed25519',{extractable:true});
  const encrypt=await generateKeyPair('ECDH-ES',{crv:'P-256',extractable:true});
  return {sign:signingKey.parse(await exportJWK(sign.publicKey)),encrypt:encryptionKey.parse(await exportJWK(encrypt.publicKey)),
    signPrivate:await exportJWK(sign.privateKey) as Identity['signPrivate'],encryptPrivate:await exportJWK(encrypt.privateKey) as Identity['encryptPrivate']};
}

export const rpcSchema=z.object({op:z.string().regex(/^[a-z-]{1,32}$/),body:z.record(z.unknown())}).strict();
export async function signRPC(keys:Identity,relay:string,op:string,body:Record<string,unknown>) {
  const signature=await new SignJWT(rpcSchema.parse({op,body})).setProtectedHeader({alg:'Ed25519',typ:'qoopia-bridge-rpc+jwt'})
    .setIssuer(peerId(keys)).setAudience(relay).setIssuedAt().setExpirationTime('60s').setJti(randomUUID())
    .sign(await importJWK(keys.signPrivate,'Ed25519'));
  return {identity:publicIdentity.parse({sign:keys.sign,encrypt:keys.encrypt}),signature};
}
export async function verifyRPC(raw:unknown,relay:string) {
  const envelope=z.object({identity:publicIdentity,signature:z.string().max(MAX_RPC)}).strict().parse(raw);
  const peer=peerId(envelope.identity);
  const {payload}=await jwtVerify(envelope.signature,await importJWK(envelope.identity.sign,'Ed25519'),
    {algorithms:['Ed25519'],typ:'qoopia-bridge-rpc+jwt',issuer:peer,audience:relay,maxTokenAge:60,clockTolerance:5,requiredClaims:['exp','iat','jti']});
  if(!Number.isSafeInteger(payload.exp)||!Number.isSafeInteger(payload.iat)||payload.exp!-payload.iat!>60||payload.exp!<=payload.iat!)throw new Error('Invalid RPC lifetime');
  const operation=rpcSchema.parse({op:payload.op,body:payload.body});
  return {...operation,identity:envelope.identity,peer,nonce:id.parse(payload.jti),expires:Number(payload.exp)*1000};
}

/** A retained owner decision is evidence, not a reusable live RPC credential. */
export async function ownerStatement(signature:string,owner:PublicIdentity,relay:string) {
  const result=await compactVerify(signature,await importJWK(owner.sign,'Ed25519'),{algorithms:['Ed25519']});
  const claims=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.payload));
  if(result.protectedHeader.typ!=='qoopia-bridge-rpc+jwt'||claims.iss!==peerId(owner)||claims.aud!==relay)throw new Error('Wrong owner statement');
  return rpcSchema.parse({op:claims.op,body:claims.body});
}

export const catalogueItem=z.object({id,version:fingerprint,title:label,description:z.string().max(400)}).strict();
export const packetSchema=z.object({id,group:id,from:fingerprint,to:fingerprint,created:z.number().int().positive(),
  kind:z.enum(['catalogue-request','catalogue','request','material','skipped','ack']),body:z.record(z.unknown())}).strict();
export type Packet=z.infer<typeof packetSchema>;
export async function sealPacket(keys:Identity,recipient:PublicIdentity,packet:Packet):Promise<string> {
  if(packet.from!==peerId(keys)||packet.to!==peerId(recipient))throw new Error('Packet identity mismatch');
  const signed=await new CompactSign(encode(packetSchema.parse(packet))).setProtectedHeader({alg:'Ed25519',typ:'qoopia-bridge-packet+jws'})
    .sign(await importJWK(keys.signPrivate,'Ed25519'));
  const encrypted=await new CompactEncrypt(new TextEncoder().encode(signed)).setProtectedHeader({alg:'ECDH-ES',enc:'A256GCM',typ:'qoopia-bridge-packet+jwe'})
    .encrypt(await importJWK(recipient.encrypt,'ECDH-ES'));
  if(encrypted.length>MAX_PACKET)throw new Error('Bridge packet exceeds the file limit');
  return encrypted;
}
export async function openPacket(keys:Identity,sender:PublicIdentity,encrypted:string):Promise<Packet> {
  if(encrypted.length>MAX_PACKET)throw new Error('Bridge packet too large');
  const decrypted=await compactDecrypt(encrypted,await importJWK(keys.encryptPrivate,'ECDH-ES'),
    {keyManagementAlgorithms:['ECDH-ES'],contentEncryptionAlgorithms:['A256GCM']});
  if(decrypted.protectedHeader.typ!=='qoopia-bridge-packet+jwe')throw new Error('Wrong encryption context');
  const verified=await compactVerify(new TextDecoder('utf-8',{fatal:true}).decode(decrypted.plaintext),await importJWK(sender.sign,'Ed25519'),{algorithms:['Ed25519']});
  if(verified.protectedHeader.typ!=='qoopia-bridge-packet+jws')throw new Error('Wrong signature context');
  const packet=packetSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(verified.payload)));
  if(packet.from!==peerId(sender)||packet.to!==peerId(keys)||packet.created>Date.now()+60_000||packet.created<Date.now()-7*86400_000)
    throw new Error('Packet identity or lifetime mismatch');
  return packet;
}

export function invitationCode(value:string,relay=BRIDGE_RELAY) {
  let code=value.trim();
  if(code.startsWith('https://')||code.startsWith('http://')) {
    const url=new URL(code);
    if(url.origin+url.pathname!==relay+'/invite'||url.search)throw new Error('Use an invitation from the configured Qoopia bridge service');
    code=url.hash.slice(1);
  }
  const match=/^QPB1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(code);
  if(!match)throw new Error('Paste a complete Qoopia invitation link or code');
  return {code,secret:match[1]!,owner:match[2]!};
}
