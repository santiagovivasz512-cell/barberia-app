require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

require("./src/db"); // inicializa y siembra la base de datos

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Barberia app escuchando en http://localhost:${PORT}`);
});
