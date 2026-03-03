import "dotenv/config";
import path from "node:path";
import { createServer } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import methodOverride from "method-override";
import { PrismaClient } from "@prisma/client";
import apiRouter from "./routes/api.js";
import pagesRouter from "./routes/pages.js";
import lessonsRouter from "./routes/lessons.js";
import { initSocketIO } from "./socket/classroom.js";

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);
const ROOT_DIR = process.cwd();
const port = Number(process.env.PORT) || 3000;

// Initialize Socket.io
const io = initSocketIO(httpServer);

app.set("view engine", "ejs");
app.set("views", path.join(ROOT_DIR, "src", "views"));

app.use(express.static(path.join(ROOT_DIR, "public")));
app.use("/fonts/brand", express.static(path.join(ROOT_DIR, "..", "..", "Think different Academy CZ-20251210T193908Z-3-001", "Think different Academy CZ", "TdA _ Fonts", "static")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(
	session({
		secret: process.env.SESSION_SECRET || "tda26-session",
		resave: false,
		saveUninitialized: false,
		cookie: {
			sameSite: "lax",
		},
	}),
);

app.use((req, res, next) => {
	req.prisma = prisma;
	res.locals.user = req.session.user ?? null;
	next();
});

// Simple request logger to help debugging in production
app.use((req, _res, next) => {
	console.log(`[request] ${req.method} ${req.originalUrl}`);
	if (req.method !== "GET") {
		try {
			console.log(`[request-body] ${JSON.stringify(req.body)}`);
		} catch (e) {
			// ignore
		}
	}
	next();
});

// Health endpoint used by tests / debug
app.get("/api/health", async (_req, res) => {
	try {
		// quick DB check
		await prisma.$queryRaw`SELECT 1`;
		res.json({ status: "ok", db: "ok" });
	} catch (err) {
		console.error("health check db error", err);
		res.status(500).json({ status: "error", db: "error" });
	}
});

app.use(pagesRouter);
app.use("/api", apiRouter);
app.use("/api", lessonsRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
	console.error(err);
	res.status(500).render("error", { title: "Chyba", message: "Něco se pokazilo." });
});

httpServer.listen(port, "0.0.0.0", () => {
	console.log(`Server listening on http://0.0.0.0:${port}`);
});
