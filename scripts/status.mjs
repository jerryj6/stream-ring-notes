import "dotenv/config";

const check = process.argv.includes("--check-instagram");
const path = check ? "instagram" : "status";
if (!process.env.API_KEY) throw new Error("Set API_KEY in .env first.");

const response = await fetch(`http://127.0.0.1:${process.env.PORT || 4317}/api/stream/${path}`, {
  headers: { Authorization: "Bearer " + process.env.API_KEY },
  signal: AbortSignal.timeout(45000),
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
