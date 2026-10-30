import CryptoJS from 'crypto-js';

const KEY = 'pandingding88888';
const IV = '88888pandingding';

/**
 * 与原始产物中的 `Ix` 类完全一致的 AES-CBC/PKCS7 实现。
 * 密文为 hex 且大写，与 *.dat 文件内的 data 字段同格式。
 */
export class Ix {
  constructor() {
    this.key = CryptoJS.enc.Utf8.parse(KEY);
    this.iv = CryptoJS.enc.Utf8.parse(IV);
  }

  encrypt(text) {
    const words = CryptoJS.enc.Utf8.parse(text);
    return CryptoJS.AES.encrypt(words, this.key, {
      iv: this.iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    })
      .ciphertext.toString()
      .toUpperCase();
  }

  decrypt(hex) {
    const words = CryptoJS.enc.Hex.parse(hex);
    const base64 = CryptoJS.enc.Base64.stringify(words);
    return CryptoJS.AES.decrypt(base64, this.key, {
      iv: this.iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    })
      .toString(CryptoJS.enc.Utf8)
      .toString();
  }
}
