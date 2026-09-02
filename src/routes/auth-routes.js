const express = require("express");
const bcrypt = require("bcryptjs");
const { getSetting } = require("../db");
const { signToken } = require("../auth");

const router = express.Router();

router.post("/login", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Falta la contrasena." });

  const hash = getSetting("admin_password_hash", null);
  if (!hash || !bcrypt.compareSync(password, hash)) {
    return res.status(401).json({ error: "Contrasena incorrecta." });
  }
  res.json({ token: signToken() });
});

module.exports = router;
