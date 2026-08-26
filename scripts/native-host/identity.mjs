import { createHash, createPublicKey } from "node:crypto";

export const CHROMIUM_PUBLIC_KEY_DER_BASE64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAthJlBMpMQ7riLovk+Bc98iJlz6Di/lpVUPBK2E75cG5yW9hVP/ttRd3MPVaM0m7tVnFZr3o4+NQ/18yPKdnvVkJ8EWv3E4HWRIZwyz5qd79iA18cIWcESKgSm9Dq8NuoMzhtx63K1Jcq6VDNeRHAfGY82kZUn36JGEhjBxLXap/mRvFDYVNuwfuAZ89A46g68momf1cBIw+3wS+V9Mff2zTEWkzw2Q+Dbmd+jc1wiK7ktxlSNQsf8+7pftZI7NhVg8ZuEMf2LPShhFb2iykuaXeeLiCrbMm20t8PFmddZVzNvy30Boc/Y7MqzKO3+mEpRQlbCFDG0QbnKm23GDVhswIDAQAB";

export const CHROMIUM_EXTENSION_ID = "kaknffcpoififkcmhphedbajjbacfaof";
export const CHROME_WEB_STORE_EXTENSION_ID = "bfcgihgadankhhijhhdlkekecfmbihef";

function decodePublicDer(publicKeyBase64) {
  if (
    typeof publicKeyBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(publicKeyBase64)
  ) {
    throw new TypeError("Chromium public key must be canonical base64 DER.");
  }
  const der = Buffer.from(publicKeyBase64, "base64");
  if (der.length === 0 || der.toString("base64") !== publicKeyBase64) {
    throw new TypeError("Chromium public key must be canonical base64 DER.");
  }
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 2048) {
      throw new TypeError("Chromium public key must be a 2048-bit RSA DER key.");
    }
    if (!Buffer.from(key.export({ format: "der", type: "spki" })).equals(der)) {
      throw new TypeError("Chromium public key DER must not contain trailing data.");
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Chromium public key must be valid DER.");
  }
  return der;
}

export function getChromiumExtensionId(publicKeyBase64) {
  const digest = createHash("sha256").update(decodePublicDer(publicKeyBase64)).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(hex, 16)));
}
