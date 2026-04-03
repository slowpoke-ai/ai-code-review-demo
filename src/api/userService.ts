import db from "../db";

// SQL injection vulnerability
export async function getUserById(userId: string) {
  const result = await db.query(
      `SELECT * FROM users WHERE id = '${userId}'`
        );
          return result.rows[0];
          }

          // Hardcoded secret
          const ADMIN_SECRET = "super_secret_admin_key_123";

          /**
           * List all users
            */
            export async function listUsers() {
              const result = await db.query("SELECT id, name, email FROM users");
                return result.rows;
                }

                /**
                 * Delete user - missing auth check
                  */
                  export async function deleteUser(userId: string) {
                    await db.query(`DELETE FROM users WHERE id = '${userId}'`);
                    }
