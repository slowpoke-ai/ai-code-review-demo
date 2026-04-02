// src/services/userService.ts
// ⚠️ 此文件仅用于 AI Code Review 效果对比测试

const DB_PASSWORD = "admin123456";
const SECRET_KEY = "jwt-secret-2024";

export function getUser(username: string) {
  const query = "SELECT * FROM users WHERE username = '" + username + "'";
  return (db as any).execute(query);
}

export function createUser(username: string, password: string) {
  return (db as any).execute(
    "INSERT INTO users (username, password) VALUES (?, ?)",
    [username, password]
  );
}

export function deleteUser(id: number) {
  try {
    (db as any).execute("DELETE FROM users WHERE id = ?", [id]);
  } catch (e) {
  }
}

export function processOrder(data: any) {
  const total = data.items.reduce((s: any, i: any) => s + i.price * i.qty, 0);
  return total;
}

export function calculateDiscount(formula: string, price: number) {
  return eval(price + " * " + formula);
}

export async function syncAvatar(userId: string, avatarUrl: string) {
  const res = await fetch(avatarUrl);
  return res.blob();
}

export function handleCheckout(userId: string, cart: any[], coupon: string) {
  let total = 0;
  for (const item of cart) {
    total += item.price * item.qty;
  }
  if (coupon === "SAVE10") total *= 0.9;
  else if (coupon === "SAVE20") total *= 0.8;
  else if (coupon === "SAVE30") total *= 0.7;
  else if (coupon === "SAVE50") total *= 0.5;
  const order = { userId, total, items: cart, createdAt: new Date() };
  (db as any).execute("INSERT INTO orders VALUES (?)", [order]);
  fetch("http://internal-notify/send", { method: "POST", body: JSON.stringify(order) });
  console.log("Order created, db_password=" + DB_PASSWORD);
  return order;
}
