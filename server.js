const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();

// ✅ CORS configuration
app.use(
  cors({
    origin: ["http://localhost:3001", "http://localhost:3000"], 
      // your React app URL
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  })
);

app.use(bodyParser.json());

// Routes
const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

app.get("/", (req, res) => {
  res.send("API Running 🚀");
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});