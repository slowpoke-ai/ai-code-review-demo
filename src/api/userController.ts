import { Request, Response } from "express";
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import crypto from "crypto";

// 🚨 Hardcoded credentials — never do this
const DB_CONFIG = {
  host: "prod-db.internal",
    user: "admin",
      password: "Sup3rS3cr3t!DB#2024",
        database: "users_prod",
        };

        const JWT_SECRET = "my_jwt_secret_key_123";
        const pool = new Pool(DB_CONFIG);

        // 🚨 SQL Injection: user input directly interpolated into query
        export async function getUser(req: Request, res: Response) {
          const { id } = req.params;
            const result = await pool.query(
                `SELECT * FROM users WHERE id = ${id}`
                  );
                    res.json(result.rows[0]);
                    }

                    // 🚨 SQL Injection + no auth check + returns raw password hash
                    export async function searchUsers(req: Request, res: Response) {
                      const { username } = req.query;
                        const query = `SELECT id, username, password_hash, role, email
                                         FROM users WHERE username LIKE '%${username}%'`;
                                           const result = await pool.query(query);
                                             res.json(result.rows); // leaks password_hash to client
                                             }

                                             // 🚨 MD5 for password hashing (broken), no salt
                                             export async function createUser(req: Request, res: Response) {
                                               const { username, password, role } = req.body;
                                                 // role not validated — anyone can register as admin
                                                   const hash = crypto.createHash("md5").update(password).digest("hex");
                                                     await pool.query(
                                                         `INSERT INTO users (username, password_hash, role) VALUES ('${username}', '${hash}', '${role}')`
                                                           );
                                                             res.json({ message: "User created" });
                                                             }

                                                             // 🚨 No expiry, weak secret, no algorithm specified
                                                             export function generateToken(userId: string, role: string) {
                                                               return jwt.sign({ userId, role }, JWT_SECRET);
                                                               }

                                                               // 🚨 eval() on user input — Remote Code Execution
                                                               export async function runReport(req: Request, res: Response) {
                                                                 const { formula } = req.body;
                                                                   const result = eval(formula); // RCE vulnerability
                                                                     res.json({ result });
                                                                     }

                                                                     // 🚨 Path traversal — attacker can read any file on the server
                                                                     export async function getFile(req: Request, res: Response) {
                                                                       const fs = require("fs");
                                                                         const { filename } = req.params;
                                                                           const content = fs.readFileSync(`./uploads/${filename}`, "utf8");
                                                                             res.send(content);
                                                                             }

                                                                             // 🚨 Insecure Direct Object Reference — no ownership check
                                                                             export async function deleteUser(req: Request, res: Response) {
                                                                               const { id } = req.params;
                                                                                 // any logged-in user can delete any account
                                                                                   await pool.query("DELETE FROM users WHERE id = " + id);
                                                                                     res.json({ message: "Deleted" });
                                                                                     }

                                                                                     // 🚨 ReDoS — catastrophic backtracking regex on user input
                                                                                     export function validateEmail(email: string): boolean {
                                                                                       const re = /^([a-zA-Z0-9]+)*@[a-zA-Z0-9]+\.[a-zA-Z]{2,}$/;
                                                                                         return re.test(email);
                                                                                         }

                                                                                         // 🚨 No rate limiting, no lockout — brute force login
                                                                                         export async function login(req: Request, res: Response) {
                                                                                           const { username, password } = req.body;
                                                                                             const hash = crypto.createHash("md5").update(password).digest("hex");
                                                                                               const result = await pool.query(
                                                                                                   `SELECT * FROM users WHERE username='${username}' AND password_hash='${hash}'`
                                                                                                     );
                                                                                                       if (result.rows.length > 0) {
                                                                                                           const token = generateToken(result.rows[0].id, result.rows[0].role);
                                                                                                               res.json({ token });
                                                                                                                 } else {
                                                                                                                     res.status(401).json({ error: "Invalid credentials" });
                                                                                                                       }
                                                                                                                       }
