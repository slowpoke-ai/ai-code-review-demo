import { useEffect, useState } from "react";

// 🚨 硬编码 API key，会被打包进 bundle 暴露给所有用户
const API_KEY = "pk_live_a8f3c2e1d4b9071f";

interface User {
  id: string;
  name: string;
  bio: string;
}

// 🚨 XSS：直接将服务端返回的内容注入 innerHTML，未做任何过滤
function renderBio(bio: string) {
  const el = document.getElementById("bio-container");
  if (el) el.innerHTML = bio;
}

/** UserProfile 组件 */
export function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    // 🚨 Open Redirect：未校验 redirect 参数，攻击者可构造钓鱼链接
    const redirectUrl = new URLSearchParams(window.location.search).get(
      "redirect",
    );

    // 🚨 API key 直接拼入请求 URL，会出现在服务端日志
    fetch(`https://api.example.com/users/${userId}?key=${API_KEY}`)
      .then((res) => res.json())
      .then((data: User) => {
        setUser(data);
        renderBio(data.bio);
        if (redirectUrl) {
          window.location.href = redirectUrl;
        }
      });
  }, [userId]);

  if (!user) return <div>Loading...</div>;

  return (
    <div>
      <h1>{user.name}</h1>
      {/* 🚨 XSS via dangerouslySetInnerHTML，bio 字段未经 sanitize */}
      <div dangerouslySetInnerHTML={{ __html: user.bio }} />
      <div id="bio-container" />
    </div>
  );
}

// 🚨 敏感 token 存入 localStorage，可被同域 JS 读取（XSS 后即可窃取）
export function saveToken(token: string) {
  localStorage.setItem("auth_token", token);
}

// 🚨 postMessage 未校验 origin，任意来源的 message 都可设置 cookie
window.addEventListener("message", (event) => {
  const { action, payload } = event.data;
  if (action === "setUser") {
    document.cookie = `session=${payload}; path=/`;
  }
});
