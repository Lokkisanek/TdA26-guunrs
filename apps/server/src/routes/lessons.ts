import { Router } from "express";
import { isAuthenticated } from "../middleware/auth.js";

const lessonsRouter = Router();

// ──────────── LESSONS CRUD ────────────

// List lessons for a course
lessonsRouter.get("/courses/:courseId/lessons", async (req, res, next) => {
  try {
    const lessons = await req.prisma.lesson.findMany({
      where: { courseId: req.params.courseId },
      orderBy: { order: "asc" },
      include: {
        pages: { orderBy: { order: "asc" } },
        liveSessions: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    res.json(lessons);
  } catch (error) {
    next(error);
  }
});

// Get single lesson
lessonsRouter.get("/lessons/:id", async (req, res, next) => {
  try {
    const lesson = await req.prisma.lesson.findUnique({
      where: { id: req.params.id },
      include: {
        pages: { orderBy: { order: "asc" } },
        liveSessions: { orderBy: { createdAt: "desc" } },
        course: true,
      },
    });
    if (!lesson) return res.status(404).json({ error: "Lesson not found" });
    res.json(lesson);
  } catch (error) {
    next(error);
  }
});

// Create lesson
lessonsRouter.post("/courses/:courseId/lessons", isAuthenticated, async (req, res, next) => {
  try {
    const { title, description } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "Field 'title' is required" });

    // Auto-calculate order
    const maxOrder = await req.prisma.lesson.aggregate({
      where: { courseId: req.params.courseId },
      _max: { order: true },
    });

    const lesson = await req.prisma.lesson.create({
      data: {
        courseId: req.params.courseId,
        title: title.trim(),
        description: description?.trim() || null,
        order: (maxOrder._max.order ?? -1) + 1,
      },
      include: { pages: true },
    });

    res.status(201).json(lesson);
  } catch (error) {
    next(error);
  }
});

// Update lesson
lessonsRouter.put("/lessons/:id", isAuthenticated, async (req, res, next) => {
  try {
    const { title, description, order } = req.body;
    const lesson = await req.prisma.lesson.update({
      where: { id: req.params.id },
      data: {
        ...(title ? { title: title.trim() } : {}),
        ...(description !== undefined ? { description: description?.trim() || null } : {}),
        ...(order !== undefined ? { order: Number(order) } : {}),
      },
      include: { pages: true },
    });
    res.json(lesson);
  } catch (error) {
    next(error);
  }
});

// Delete lesson
lessonsRouter.delete("/lessons/:id", isAuthenticated, async (req, res, next) => {
  try {
    await req.prisma.lesson.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// ──────────── DUPLICATE LESSON ────────────
// Deep copy: Lesson + all LessonPages (preserving isPublished).
// Does NOT copy LiveSessions, QuizResults, or attendance statistics.
lessonsRouter.post("/lessons/:id/duplicate", isAuthenticated, async (req, res, next) => {
  try {
    const original = await req.prisma.lesson.findUnique({
      where: { id: req.params.id },
      include: { pages: { orderBy: { order: "asc" } } },
    });
    if (!original) return res.status(404).json({ error: "Lesson not found" });

    // Determine order for the copy
    const maxOrder = await req.prisma.lesson.aggregate({
      where: { courseId: original.courseId },
      _max: { order: true },
    });

    // Create duplicated lesson
    const duplicated = await req.prisma.lesson.create({
      data: {
        courseId: original.courseId,
        title: `Copy of ${original.title}`,
        description: original.description,
        order: (maxOrder._max.order ?? -1) + 1,
        // Deep copy pages
        pages: {
          create: original.pages.map((page) => ({
            title: page.title,
            content: page.content,
            type: page.type,
            order: page.order,
            isPublished: page.isPublished,
          })),
        },
        // Create a fresh DRAFT session for the duplicated lesson
        liveSessions: {
          create: {
            currentState: "DRAFT",
          },
        },
      },
      include: {
        pages: { orderBy: { order: "asc" } },
        liveSessions: true,
      },
    });

    res.status(201).json(duplicated);
  } catch (error) {
    next(error);
  }
});

// ──────────── LESSON PAGES CRUD ────────────

// List pages for a lesson
lessonsRouter.get("/lessons/:lessonId/pages", async (req, res, next) => {
  try {
    const pages = await req.prisma.lessonPage.findMany({
      where: { lessonId: req.params.lessonId },
      orderBy: { order: "asc" },
    });
    res.json(pages);
  } catch (error) {
    next(error);
  }
});

// Create page
lessonsRouter.post("/lessons/:lessonId/pages", isAuthenticated, async (req, res, next) => {
  try {
    const { title, content, type, isPublished } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "Field 'title' is required" });

    const validTypes = ["video", "text", "quiz", "empty_stylized"];
    const pageType = validTypes.includes(type) ? type : "text";

    const maxOrder = await req.prisma.lessonPage.aggregate({
      where: { lessonId: req.params.lessonId },
      _max: { order: true },
    });

    const page = await req.prisma.lessonPage.create({
      data: {
        lessonId: req.params.lessonId,
        title: title.trim(),
        content: content || null,
        type: pageType,
        order: (maxOrder._max.order ?? -1) + 1,
        isPublished: isPublished !== false,
      },
    });
    res.status(201).json(page);
  } catch (error) {
    next(error);
  }
});

// Update page
lessonsRouter.put("/pages/:id", isAuthenticated, async (req, res, next) => {
  try {
    const { title, content, type, order, isPublished } = req.body;
    const validTypes = ["video", "text", "quiz", "empty_stylized"];

    const page = await req.prisma.lessonPage.update({
      where: { id: req.params.id },
      data: {
        ...(title ? { title: title.trim() } : {}),
        ...(content !== undefined ? { content: content || null } : {}),
        ...(type && validTypes.includes(type) ? { type } : {}),
        ...(order !== undefined ? { order: Number(order) } : {}),
        ...(isPublished !== undefined ? { isPublished: Boolean(isPublished) } : {}),
      },
    });
    res.json(page);
  } catch (error) {
    next(error);
  }
});

// Delete page
lessonsRouter.delete("/pages/:id", isAuthenticated, async (req, res, next) => {
  try {
    await req.prisma.lessonPage.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// ──────────── LIVE SESSIONS ────────────

// Create a live session for a lesson
lessonsRouter.post("/lessons/:lessonId/sessions", isAuthenticated, async (req, res, next) => {
  try {
    const session = await req.prisma.liveSession.create({
      data: {
        lessonId: req.params.lessonId,
        currentState: "DRAFT",
        activeInstructorId: req.session.user?.username || null,
      },
    });
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

// Get live session
lessonsRouter.get("/sessions/:id", async (req, res, next) => {
  try {
    const session = await req.prisma.liveSession.findUnique({
      where: { id: req.params.id },
      include: {
        lesson: {
          include: {
            pages: { orderBy: { order: "asc" } },
            course: true,
          },
        },
        activePage: true,
        quizResults: true,
      },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (error) {
    next(error);
  }
});

// Update live session state (REST fallback — primary control via Socket.io)
lessonsRouter.patch("/sessions/:id", isAuthenticated, async (req, res, next) => {
  try {
    const { currentState, activePageId } = req.body;
    const validStates = ["DRAFT", "SCHEDULED", "LIVE", "PAUSED", "ARCHIVED"];

    const session = await req.prisma.liveSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Instructor lock: only the active instructor can change state
    if (session.activeInstructorId && session.activeInstructorId !== req.session.user?.username) {
      return res.status(403).json({ error: "Only the active instructor can modify this session" });
    }

    const data: Record<string, unknown> = {};

    if (currentState && validStates.includes(currentState)) {
      data.currentState = currentState;
      if (currentState === "LIVE" && !session.startedAt) {
        data.startedAt = new Date();
      }
      if (currentState === "ARCHIVED") {
        data.endedAt = new Date();
      }
    }

    if (activePageId !== undefined) {
      data.activePageId = activePageId || null;
    }

    if (!session.activeInstructorId) {
      data.activeInstructorId = req.session.user?.username || null;
    }

    const updated = await req.prisma.liveSession.update({
      where: { id: req.params.id },
      data,
      include: { activePage: true },
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// ──────────── QUIZ RESULTS ────────────

// Submit quiz result (REST fallback — primary submission via Socket.io)
lessonsRouter.post("/sessions/:sessionId/quiz", async (req, res, next) => {
  try {
    const { lessonPageId, studentId, score, answers } = req.body;
    if (!lessonPageId || !studentId) {
      return res.status(400).json({ error: "lessonPageId and studentId are required" });
    }

    const result = await req.prisma.quizResult.create({
      data: {
        liveSessionId: req.params.sessionId,
        lessonPageId,
        studentId,
        score: Number(score) || 0,
        answersJson: answers ? JSON.stringify(answers) : null,
      },
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// Get quiz results for a session (teacher analytics)
lessonsRouter.get("/sessions/:sessionId/results", isAuthenticated, async (req, res, next) => {
  try {
    const results = await req.prisma.quizResult.findMany({
      where: { liveSessionId: req.params.sessionId },
      include: { lessonPage: true },
      orderBy: { submittedAt: "desc" },
    });

    // Compute analytics
    const byPage = new Map<string, { total: number; sum: number; title: string }>();
    for (const r of results) {
      const existing = byPage.get(r.lessonPageId) || { total: 0, sum: 0, title: r.lessonPage.title };
      existing.total += 1;
      existing.sum += r.score;
      byPage.set(r.lessonPageId, existing);
    }

    const analytics = Array.from(byPage.entries()).map(([pageId, data]) => ({
      pageId,
      pageTitle: data.title,
      totalSubmissions: data.total,
      averageScore: data.total > 0 ? Math.round((data.sum / data.total) * 100) / 100 : 0,
    }));

    res.json({ results, analytics });
  } catch (error) {
    next(error);
  }
});

export default lessonsRouter;
