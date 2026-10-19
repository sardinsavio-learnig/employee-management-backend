require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const helmet = require("helmet");

const app = express();
const PORT = Number(process.env.PORT || 5000);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing from .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://localhost:5173"
].filter(Boolean);

app.disable("x-powered-by");
app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin is not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "20kb" }));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      department VARCHAR(100) NOT NULL,
      position VARCHAR(120) NOT NULL,
      salary NUMERIC(12,2) NOT NULL CHECK (salary >= 0),
      status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function validateEmployee(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const fields = [
    "name", "email", "department",
    "position", "salary", "status"
  ];

  const data = {};

  for (const field of fields) {
    if (partial && body[field] === undefined) continue;

    if (!partial && body[field] === undefined) {
      if (field === "status") continue;
      return { error: `${field} is required.` };
    }

    data[field] = body[field];
  }

  for (const field of ["name", "email", "department", "position"]) {
    if (data[field] !== undefined) {
      if (typeof data[field] !== "string" || !data[field].trim()) {
        return { error: `${field} must be a non-empty string.` };
      }
      data[field] = data[field].trim();
    }
  }

  if (data.email !== undefined) {
    data.email = data.email.toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      return { error: "Please provide a valid email address." };
    }
  }

  if (data.salary !== undefined) {
    if (
      data.salary === "" ||
      data.salary === null ||
      !Number.isFinite(Number(data.salary)) ||
      Number(data.salary) < 0
    ) {
      return { error: "Salary must be a non-negative number." };
    }

    data.salary = Number(data.salary);
  }

  if (data.status === undefined && !partial) {
    data.status = "Active";
  }

  if (
    data.status !== undefined &&
    !["Active", "Inactive"].includes(data.status)
  ) {
    return { error: "Status must be Active or Inactive." };
  }

  return { data };
}

function handleError(res, error) {
  console.error(error);

  if (error.code === "23505") {
    return res.status(409).json({
      message: "An employee with this email already exists."
    });
  }

  if (["23514", "23502", "22P02"].includes(error.code)) {
    return res.status(400).json({
      message: "Invalid employee data."
    });
  }

  return res.status(500).json({
    message: "Internal server error."
  });
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    handleError(res, error);
  }
});

// List and search employees
app.get("/api/employees", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    const result = await pool.query(
      `SELECT *
       FROM employees
       WHERE name ILIKE $1
          OR email ILIKE $1
          OR department ILIKE $1
          OR position ILIKE $1
       ORDER BY id DESC`,
      [`%${search}%`]
    );

    res.json(result.rows);
  } catch (error) {
    handleError(res, error);
  }
});

// Get one employee
app.get("/api/employees/:id", async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ message: "Invalid employee ID." });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM employees WHERE id = $1",
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Employee not found." });
    }

    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error);
  }
});

// Create employee
app.post("/api/employees", async (req, res) => {
  const validation = validateEmployee(req.body);

  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const {
    name, email, department, position, salary, status
  } = validation.data;

  try {
    const result = await pool.query(
      `INSERT INTO employees
       (name, email, department, position, salary, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, email, department, position, salary, status]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    handleError(res, error);
  }
});

// Update employee
app.put("/api/employees/:id", async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ message: "Invalid employee ID." });
  }

  const validation = validateEmployee(req.body, true);

  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const allowed = new Set([
    "name", "email", "department",
    "position", "salary", "status"
  ]);

  const fields = Object.keys(validation.data);

  if (!fields.length || fields.some(field => !allowed.has(field))) {
    return res.status(400).json({
      message: "Provide valid fields to update."
    });
  }

  const values = fields.map(field => validation.data[field]);
  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`
  );

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE employees
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Employee not found." });
    }

    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error);
  }
});

// Delete employee
app.delete("/api/employees/:id", async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ message: "Invalid employee ID." });
  }

  try {
    const result = await pool.query(
      "DELETE FROM employees WHERE id = $1 RETURNING id",
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Employee not found." });
    }

    res.json({ message: "Employee deleted successfully." });
  } catch (error) {
    handleError(res, error);
  }
});

app.use((err, req, res, next) => {
  if (err.message === "Origin is not allowed by CORS") {
    return res.status(403).json({ message: "Origin is not allowed." });
  }

  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ message: "Invalid JSON body." });
  }

  console.error(err);
  res.status(500).json({ message: "Internal server error." });
});

async function startServer() {
  try {
    await initializeDatabase();
    await pool.query("SELECT 1");

    app.listen(PORT, "127.0.0.1", () => {
      console.log(`Employee API listening on 127.0.0.1:${PORT}`);
      console.log("PostgreSQL connected successfully.");
    });
  } catch (error) {
    console.error("Failed to start:", error.message);
    process.exit(1);
  }
}

startServer();

async function shutdown() {
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
