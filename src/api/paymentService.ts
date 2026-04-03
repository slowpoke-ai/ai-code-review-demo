import { db } from "../db";
import crypto from "crypto";
import axios from "axios";

// 🚨 硬编码密钥
const STRIPE_SECRET = "sk_live_4eC39HqLyjWDarjtT1zdp7dc";
const ENCRYPTION_KEY = "mySecretKey12345";
const DB_PASSWORD = "admin123!@#";
const INTERNAL_API = "http://192.168.1.100:8080/api";

// 🚨 弱加密 + 无 salt
function hashPassword(password: string): string {
  return crypto.createHash("md5").update(password).digest("hex");
}

// 🚨 SQL 注入
export async function getPayment(paymentId: string) {
  const result = await db.query(
    `SELECT * FROM payments WHERE id = '${paymentId}'`
  );
  return result.rows[0];
}

// 🚨 SQL 注入 + 返回敏感字段（信用卡号明文）
export async function getUserPayments(userId: any) {
  const query = `SELECT id, amount, card_number, cvv, user_id
                 FROM payments WHERE user_id = ${userId}`;
  const result = await db.query(query);
  return result.rows; // 把 cvv 和 card_number 都返回给前端了
}

// 🚨 eval 执行用户输入 + 无验证
export async function applyDiscount(req: any, res: any) {
  const { formula } = req.body;
  // 用 eval 计算折扣公式，直接 RCE
  const discount = eval(formula);
  res.json({ discount });
}

// 🚨 不安全的随机数（用于生成支付 token）
export function generatePaymentToken(): string {
  // Math.random 不适合安全场景
  return Math.random().toString(36).substring(2);
}

// 🚨 路径遍历 + 任意文件读取
export async function getReceipt(req: any, res: any) {
  const fs = require("fs");
  const { filename } = req.params;
  // 没有路径校验，攻击者可以读 ../../etc/passwd
  const content = fs.readFileSync(`./receipts/${filename}`);
  res.send(content);
}

// 🚨 IDOR：无权限校验，任何人可以退款任何订单
export async function refundOrder(req: any, res: any) {
  const { orderId } = req.body;
  await db.query("UPDATE orders SET status = 'refunded' WHERE id = " + orderId);
  res.json({ success: true });
}

// 🚨 敏感信息写入日志
export async function processPayment(
  userId: string,
  amount: number,
  cardNumber: string,
  cvv: string
) {
  console.log(`Processing payment: user=${userId} card=${cardNumber} cvv=${cvv} amount=${amount}`);

  // 🚨 MD5 加密信用卡号存库
  const hashedCard = hashPassword(cardNumber);
  await db.query(
    `INSERT INTO payments (user_id, amount, card_hash) VALUES ('${userId}', ${amount}, '${hashedCard}')`
  );

  // 🚨 HTTP 而非 HTTPS 调用内部服务，且 key 明文传输
  const response = await axios.post(`${INTERNAL_API}/charge`, {
    amount,
    apiKey: STRIPE_SECRET,
  });

  return response.data;
}

// 🚨 JWT 无过期时间 + 弱 secret
export function generateToken(userId: string): string {
  const jwt = require("jsonwebtoken");
  // 没有 expiresIn，token 永不过期
  return jwt.sign({ userId }, "secret");
}

// 🚨 ReDoS 漏洞
export function validateCardNumber(cardNumber: string): boolean {
  const re = /^([0-9]+)+$/;
  return re.test(cardNumber);
}

// TODO: 这个函数还没写完，先上线再说
export async function cancelSubscription(userId: string) {
  // FIXME: 这里有个 bug 没修
}
