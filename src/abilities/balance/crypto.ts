/**
 * balance 能力的加解密入口 —— 转发到框架级保险箱。
 *
 * 历史 `enc:v1:` 密文由框架 `decryptSecret` 兼容读取；新写入一律 `enc:v2:`。
 */
export {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  getMachineFingerprint as getMachineId
} from '../../main/process/encrypt'
