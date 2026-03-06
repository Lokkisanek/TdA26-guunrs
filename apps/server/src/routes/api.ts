import { Router, type Response } from "express";
import { isAuthenticated } from "../middleware/auth.js";

const apiRouter = Router();

const emptyCollections = () => ({
  materials: [] as unknown[],
  quizzes: [] as unknown[],
  feed: [] as unknown[],
});

// SSE clients per courseId
const sseClients = new Map<string, Set<Response>>();

function sendSseToCourse(courseId: string, event: string, payload: unknown) {
  const clients = sseClients.get(courseId);
  if (!clients) return;
  const data = JSON.stringify(payload);
  for (const res of clients) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
    } catch (e) {
      // ignore write errors
    }
  }
}

type DbCourse = {
  id: string;
  title: string;
  shortDescription: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function summarizeDescription(description: string | null, fallback: string) {
  const base = description?.trim() || fallback.trim();
  if (base.length <= 140) return base;
  return `${base.slice(0, 137)}...`;
}

function toApiCourse(course: DbCourse) {
  return {
    uuid: course.id,
    name: course.title,
    description: course.description ?? "",
    shortDescription: course.shortDescription,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
    ...emptyCollections(),
  };
}

apiRouter.get("/", (_req, res) => {
  res.json({ organization: "Student Cyber Games" });
});

apiRouter.get("/courses", async (req, res, next) => {
  try {
    const courses = await req.prisma.course.findMany({
      where: { visibility: "LIVE" },
      orderBy: { createdAt: "desc" },
    });
    res.json(courses.map(toApiCourse));
  } catch (error) {
    next(error);
  }
});

apiRouter.get("/courses/:id", async (req, res, next) => {
  try {
    const course = await req.prisma.course.findUnique({
      where: { id: req.params.id },
    });

    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    res.json(toApiCourse(course));
  } catch (error) {
    next(error);
  }
});

apiRouter.post("/courses", async (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const description =
      typeof req.body?.description === "string" ? req.body.description.trim() : "";

    if (!name) {
      return res.status(400).json({ error: "Field 'name' is required" });
    }

    const created = await req.prisma.course.create({
      data: {
        title: name,
        shortDescription: summarizeDescription(description || null, name),
        description: description || null,
      },
    });
    res.status(201).json(toApiCourse(created));
  } catch (error) {
    next(error);
  }
});

apiRouter.put("/courses/:id", async (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
    const description =
      typeof req.body?.description === "string" ? req.body.description.trim() : undefined;

    if (!name && description === undefined) {
      return res.status(400).json({ error: "Provide 'name' and/or 'description'" });
    }

    const updated = await req.prisma.course.update({
      where: { id: req.params.id },
      data: {
        ...(name ? { title: name } : {}),
        ...(description !== undefined
          ? {
              description: description || null,
              shortDescription: summarizeDescription(description || null, name ?? ""),
            }
          : {}),
      },
    });
    res.json(toApiCourse(updated));
  } catch (error) {
    next(error);
  }
});

apiRouter.delete("/courses/:id", async (req, res, next) => {
  try {
    await req.prisma.course.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// Feed: list entries for course
apiRouter.get("/courses/:id/feed", async (req, res, next) => {
  try {
    const entries = await req.prisma.feedEntry.findMany({
      where: { courseId: req.params.id, deleted: false },
      orderBy: { createdAt: "desc" },
    });
    res.json(entries);
  } catch (error) {
    next(error);
  }
});

// Create teacher post
apiRouter.post("/courses/:id/feed", isAuthenticated, async (req, res, next) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "Field 'text' is required" });

    const course = await req.prisma.course.findUnique({ where: { id: req.params.id } });
    if (!course) return res.status(404).json({ error: "Course not found" });

    const created = await req.prisma.feedEntry.create({
      data: {
        courseId: course.id,
        type: "TEACHER",
        content: text,
      },
    });

    sendSseToCourse(course.id, "new_entry", created);
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

// Edit teacher post
apiRouter.patch("/courses/:id/feed/:entryId", isAuthenticated, async (req, res, next) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : undefined;
    if (text === undefined) return res.status(400).json({ error: "Field 'text' is required" });

    const updated = await req.prisma.feedEntry.updateMany({
      where: { id: req.params.entryId, courseId: req.params.id, deleted: false, type: "TEACHER" },
      data: { content: text, editedAt: new Date() },
    });

    if (updated.count === 0) return res.status(404).json({ error: "Entry not found or not editable" });

    const entry = await req.prisma.feedEntry.findUnique({ where: { id: req.params.entryId } });
    if (entry) sendSseToCourse(req.params.id, "updated_entry", entry);
    res.json(entry);
  } catch (error) {
    next(error);
  }
});

// Soft-delete entry
apiRouter.delete("/courses/:id/feed/:entryId", isAuthenticated, async (req, res, next) => {
  try {
    const updated = await req.prisma.feedEntry.updateMany({
      where: { id: req.params.entryId, courseId: req.params.id, deleted: false },
      data: { deleted: true },
    });
    if (updated.count === 0) return res.status(404).json({ error: "Entry not found" });
    sendSseToCourse(req.params.id, "deleted_entry", { id: req.params.entryId });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// SSE stream for course feed
apiRouter.get("/courses/:id/feed/stream", async (req, res, next) => {
  try {
    const courseId = req.params.id;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // add client
    let clients = sseClients.get(courseId);
    if (!clients) {
      clients = new Set<Response>();
      sseClients.set(courseId, clients);
    }
    clients.add(res);

    // send initial state
    const entries = await req.prisma.feedEntry.findMany({ where: { courseId, deleted: false }, orderBy: { createdAt: "desc" } });
    res.write("event: init\n");
    res.write(`data: ${JSON.stringify(entries)}\n\n`);

    // heartbeat to keep connection alive
    const keepAlive = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch (e) {}
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      clients?.delete(res);
    });
  } catch (error) {
    next(error);
  }
});

export default apiRouter;
