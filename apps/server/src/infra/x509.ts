import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto"
import { isIPv4 } from "node:net"

// Certificados X.509 mínimos (ECDSA P-256) escritos a mano en DER: una autoridad certificadora
// local y el certificado del servidor firmado por ella. Sin dependencias: lo justo para HTTPS en
// la red local, probado contra el lector de certificados de node:crypto y una conexión TLS real.

// --- DER ---------------------------------------------------------------------------------------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  if (n <= 0xff) return Buffer.from([0x81, n])
  return Buffer.from([0x82, n >> 8, n & 0xff])
}
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts)
const set = (...parts: Buffer[]) => tlv(0x31, ...parts)
const octets = (b: Buffer) => tlv(0x04, b)
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b)
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"))

function int(value: Buffer | number): Buffer {
  let b = typeof value === "number" ? Buffer.from([value]) : value
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  b = b.subarray(i)
  // Un INTEGER con el bit alto encendido sería negativo: se antepone un cero.
  if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number)
  const out = [40 * a + b]
  for (const n of rest) {
    const chunk = [n & 0x7f]
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

/** UTCTime hasta 2049; GeneralizedTime desde 2050, como pide la RFC 5280. */
function time(ms: number): Buffer {
  const iso = new Date(ms).toISOString() // 2026-10-25T12:34:56.789Z
  const digits = iso.slice(0, 19).replace(/[-:T]/g, "")
  const year = Number(iso.slice(0, 4))
  return year < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${digits}Z`))
}

const OID = {
  ecdsaSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  subjectKeyId: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  nameConstraints: "2.5.29.30",
  authorityKeyId: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
}

const name = (cn: string, org: string) =>
  seq(set(seq(oid(OID.organization), utf8(org))), set(seq(oid(OID.commonName), utf8(cn))))

const ext = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value))

const ipBytes = (ip: string) => Buffer.from(ip.split(".").map(Number))

/** dNSName [2] o iPAddress [7] de un GeneralName. */
const generalName = (host: string) =>
  isIPv4(host) ? tlv(0x87, ipBytes(host)) : tlv(0x82, Buffer.from(host.toLowerCase(), "ascii"))

// --- Certificados ------------------------------------------------------------------------------

export interface Issued {
  /** Certificado en PEM. */
  cert: string
  /** Clave privada PKCS#8 en PEM. */
  key: string
}

const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${
    der
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? ""
  }\n-----END ${label}-----\n`

const spki = (k: KeyObject) => k.export({ type: "spki", format: "der" }) as Buffer
const keyId = (k: KeyObject) => createHash("sha1").update(spki(k)).digest()

function certificate(opts: {
  subject: Buffer
  issuer: Buffer
  publicKey: KeyObject
  signer: KeyObject
  notBefore: number
  notAfter: number
  extensions: Buffer[]
}): Buffer {
  const algorithm = seq(oid(OID.ecdsaSha256))
  const serial = randomBytes(16)
  serial[0] = (serial[0] ?? 0) & 0x7f
  const tbs = seq(
    tlv(0xa0, int(2)), // v3
    int(serial),
    algorithm,
    opts.issuer,
    seq(time(opts.notBefore), time(opts.notAfter)),
    opts.subject,
    spki(opts.publicKey),
    tlv(0xa3, seq(...opts.extensions)),
  )
  // Con claves EC, node:crypto firma en DER (SEQUENCE de r y s), como lo pide X.509.
  const signature = sign("sha256", tbs, opts.signer)
  return seq(tbs, algorithm, bits(signature))
}

/**
 * Los únicos nombres que la autoridad local puede firmar: localhost y los de la red local
 * (*.local). Si alguien se robara su clave, no le serviría para hacerse pasar por ningún dominio
 * de internet. Las direcciones IP no se restringen: no todas las bibliotecas TLS lo entienden
 * (BoringSSL, la de Bun, rechaza el certificado entero).
 */
function permittedSubtrees(): Buffer {
  return seq(
    tlv(0xa0, ...["localhost", "local"].map((n) => seq(tlv(0x82, Buffer.from(n, "ascii"))))),
  )
}

/** Una autoridad certificadora local nueva, válida 10 años. */
export function createLocalCa(opts: { commonName: string; now: number }): Issued {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const subject = name(opts.commonName, "Millhiore WINK POS")
  const der = certificate({
    subject,
    issuer: subject,
    publicKey,
    signer: privateKey,
    notBefore: opts.now - 60 * 60_000,
    notAfter: opts.now + 10 * 365 * 86_400_000,
    extensions: [
      ext(OID.basicConstraints, true, seq(bool(true), int(0))),
      // keyCertSign y cRLSign.
      ext(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)),
      ext(OID.subjectKeyId, false, octets(keyId(publicKey))),
      ext(OID.nameConstraints, true, permittedSubtrees()),
    ],
  })
  return {
    cert: pem("CERTIFICATE", der),
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  }
}

/** Lee un TLV de DER: dónde empieza (con su cabecera), dónde empieza su contenido y dónde acaba. */
function readTlv(
  buf: Buffer,
  at: number,
): { tag: number; start: number; body: number; end: number } {
  const tag = buf[at] ?? 0
  let n = buf[at + 1] ?? 0
  let body = at + 2
  if (n & 0x80) {
    const bytes = n & 0x7f
    n = 0
    for (let i = 0; i < bytes; i++) n = (n << 8) | (buf[body + i] ?? 0)
    body += bytes
  }
  return { tag, start: at, body, end: body + n }
}

/** El nombre (DER, tal cual) del sujeto de un certificado: el emisor de lo que esa autoridad firma. */
export function subjectOf(certPem: string): Buffer {
  const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ""), "base64")
  const cert = readTlv(der, 0)
  const tbs = readTlv(der, cert.body)
  let at = tbs.body
  const next = () => {
    const t = readTlv(der, at)
    at = t.end
    return t
  }
  if (readTlv(der, at).tag === 0xa0) next() // versión
  next() // número de serie
  next() // algoritmo
  next() // emisor
  next() // validez
  const subject = next()
  return der.subarray(subject.start, subject.end)
}

/**
 * El certificado del servidor para sus nombres y direcciones, firmado por la autoridad local.
 * Vale 397 días: lo más que aceptan los navegadores de Apple y Chrome.
 */
export function issueServerCert(opts: {
  ca: { cert: string; key: KeyObject; publicKey: KeyObject }
  hosts: readonly string[]
  now: number
}): Issued {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const caKeyId = keyId(opts.ca.publicKey)
  const der = certificate({
    subject: name(opts.hosts[0] ?? "localhost", "Millhiore WINK POS"),
    issuer: subjectOf(opts.ca.cert),
    publicKey,
    signer: opts.ca.key,
    notBefore: opts.now - 60 * 60_000,
    notAfter: opts.now + 397 * 86_400_000,
    extensions: [
      ext(OID.basicConstraints, true, seq()),
      // digitalSignature.
      ext(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)),
      ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      ext(OID.subjectAltName, false, seq(...opts.hosts.map(generalName))),
      ext(OID.subjectKeyId, false, octets(keyId(publicKey))),
      ext(OID.authorityKeyId, false, seq(tlv(0x80, caKeyId))),
    ],
  })
  return {
    cert: pem("CERTIFICATE", der),
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  }
}
