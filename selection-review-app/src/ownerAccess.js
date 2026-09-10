function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function assertOwnerAccessDto(value) {
  if (!exactKeys(value, ["providerType", "status", "user"]) ||
      !["development_default", "local_owner_password"].includes(value.providerType) ||
      (value.providerType === "development_default" ? value.status !== "development_only" :
        !["setup_required", "login_required", "authenticated"].includes(value.status)) ||
      (value.status === "authenticated" ? !exactKeys(value.user, ["userId"]) || typeof value.user.userId !== "string" || !value.user.userId.trim() : value.user !== null)) {
    throw new Error("主人登录状态格式无效，当前身份尚未确认。");
  }
  return value;
}

export function ownerAccessPasswordInput({ access, password, repeatedPassword }) {
  assertOwnerAccessDto(access);
  if (!["setup_required", "login_required"].includes(access.status)) throw new Error("当前状态不能提交密码，请重新读取登录状态。");
  if (typeof password !== "string" || password.length === 0) throw new Error("请填写主人密码。");
  if (password.includes("\0") || new TextEncoder().encode(password).byteLength > 1024) throw new Error("主人密码不能含空字符，且最多1024字节。");
  if (access.status === "setup_required" && [...password].length < 4) throw new Error("请设置至少4个字符的主人密码。");
  if (access.status === "setup_required" && password !== repeatedPassword) throw new Error("两次输入的密码不一致。");
  // Passwords are opaque input; do not trim or normalize their characters.
  return { password };
}
