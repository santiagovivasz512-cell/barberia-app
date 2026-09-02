require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { ready } = require("./src/db"); // inicializa y siembra la base de datos

const publicRoutes = require("./src/routes/public");
const authRoutes = require("./src/routes/auth-routes");
const adminRoutes = require("./src/routes/admin");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", publicRoutes);
app.use("/api", authRoutes);
app.use("/api/admin", adminRoutes);

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

const PORT = process.env.PORT || 3000;
ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Barberia app escuchando en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("No se pudo inicializar la base de datos:", err);
    process.exit(1);
  });
