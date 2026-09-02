const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "dev-secret-cambiame";

function signToken() {
  return jwt.sign({ role: "barber" }, SECRET, { expiresIn: "30d" });
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autenticado." });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== "barber") throw new Error("rol invalido");
    next();
  } catch (e) {
    return res.status(401).json({ error: "Sesion invalida o expirada." });
  }
}

module.exports = { signToken, requireAdmin };
