import { Router } from "express";
import "express-session";
import { isAuthenticated } from "../middleware/auth.js";
import { t } from "../i18n.js";

const USERNAME = "lecturer";
const PASSWORD = "TdA26!";

const router = Router();

// ──────────── SITEMAP ────────────
router.get("/sitemap.xml", async (req, res, next) => {
  try {
    const courses = await req.prisma.course.findMany({ orderBy: { createdAt: "desc" } });
    const host = `${req.protocol}://${req.get("host")}`;
    const urls = [
      { loc: "/", priority: "1.0", changefreq: "daily" },
      { loc: "/courses", priority: "0.9", changefreq: "daily" },
      { loc: "/login", priority: "0.3", changefreq: "monthly" },
      { loc: "/privacy-policy", priority: "0.2", changefreq: "yearly" },
      { loc: "/terms", priority: "0.2", changefreq: "yearly" },
      ...courses.map(c => ({ loc: `/courses/${c.id}`, priority: "0.8", changefreq: "weekly" as string })),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${host}${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join("\n")}
</urlset>`;
    res.type("application/xml").send(xml);
  } catch (error) {
    next(error);
  }
});

// ──────────── PUBLIC PAGES ────────────
router.get("/", (_req, res) => {
  const lang = res.locals.lang;
  res.render("home", {
    title: "",
    metaDescription: lang === "en"
      ? "Think different Academy – Interactive online courses, live lessons and quizzes. Start learning today!"
      : "Think different Academy – Interaktivní online kurzy, živé lekce a kvízy. Začněte se učit ještě dnes!",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "EducationalOrganization",
      "name": "Think different Academy",
      "description": lang === "en"
        ? "Interactive online learning platform with courses, live sessions and quizzes."
        : "Interaktivní online vzdělávací platforma s kurzy, živými relacemi a kvízy.",
      "url": "/",
      "logo": "/favicon.png",
    },
  });
});

router.get("/privacy-policy", (_req, res) => {
  res.render("privacy-policy", {
    title: t("privacy_policy", res.locals.lang),
    noIndex: true,
  });
});

router.get("/terms", (_req, res) => {
  res.render("terms", {
    title: t("terms_of_use", res.locals.lang),
    noIndex: true,
  });
});

router.get("/courses", async (req, res, next) => {
  try {
    const search = req.query.search?.toString().trim() ?? "";
    const courses = await req.prisma.course.findMany({
      where: search
        ? {
            OR: [
              { title: { contains: search } },
              { shortDescription: { contains: search } },
            ],
          }
        : undefined,
      orderBy: { createdAt: "desc" },
    });

    const lang = res.locals.lang;
    res.render("courses", {
      title: t("courses", lang),
      courses,
      search,
      metaDescription: lang === "en"
        ? "Browse all available courses at Think different Academy. Find interactive lessons, quizzes and live sessions."
        : "Procházejte všechny dostupné kurzy na Think different Academy. Najděte interaktivní lekce, kvízy a živé relace.",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": lang === "en" ? "Courses" : "Kurzy",
        "numberOfItems": courses.length,
        "itemListElement": courses.slice(0, 10).map((c: any, i: number) => ({
          "@type": "ListItem",
          "position": i + 1,
          "item": {
            "@type": "Course",
            "name": c.title,
            "description": c.shortDescription || "",
            "url": `/courses/${c.id}`,
            "provider": { "@type": "Organization", "name": "Think different Academy" },
          },
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/courses/:id", async (req, res, next) => {
  try {
    const course = await req.prisma.course.findUnique({
      where: { id: req.params.id },
      include: {
        lessons: {
          orderBy: { order: "asc" },
          include: {
            pages: { where: { isPublished: true }, orderBy: { order: "asc" } },
            liveSessions: { where: { currentState: { in: ["LIVE", "SCHEDULED"] } }, take: 1 },
          },
        },
      },
    });
    const lang = res.locals.lang;
    const seo: Record<string, any> = {
      title: course ? course.title : t("course_not_found", lang),
      course,
    };
    if (course) {
      seo.metaDescription = course.shortDescription || course.title;
      seo.ogType = "article";
      seo.jsonLd = {
        "@context": "https://schema.org",
        "@type": "Course",
        "name": course.title,
        "description": course.shortDescription || course.description || course.title,
        "provider": { "@type": "Organization", "name": "Think different Academy", "url": "/" },
        "hasCourseInstance": course.lessons?.map((l: any) => ({
          "@type": "CourseInstance",
          "name": l.title,
          "courseMode": "online",
        })) || [],
      };
    }
    res.status(course ? 200 : 404).render("course-detail", seo);
  } catch (error) {
    next(error);
  }
});

router
  .route("/login")
  .get((req, res) => {
    res.render("login", { title: t("login_title", res.locals.lang), error: null, noIndex: true });
  })
  .post((req, res) => {
    const { username, password } = req.body;
    if (username === USERNAME && password === PASSWORD) {
      req.session.user = { username };
      const redirectTo = req.session.returnTo || "/dashboard";
      delete req.session.returnTo;
      return res.redirect(redirectTo);
    }

    res.status(401).render("login", {
      title: t("login_title", res.locals.lang),
      error: t("invalid_credentials", res.locals.lang),
      noIndex: true,
    });
  });

router.post("/logout", isAuthenticated, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// ──────────── DASHBOARD ────────────
router.get("/dashboard", isAuthenticated, async (req, res, next) => {
  try {
    const courses = await req.prisma.course.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        lessons: {
          orderBy: { order: "asc" },
          include: { _count: { select: { pages: true, liveSessions: true } } },
        },
      },
    });
    res.render("dashboard", { title: "Dashboard", courses, noIndex: true });
  } catch (error) {
    next(error);
  }
});

router.post("/dashboard", isAuthenticated, async (req, res, next) => {
  try {
    const { title, shortDescription, description } = req.body;
    await req.prisma.course.create({
      data: { title, shortDescription, description: description || null },
    });
    res.redirect("/dashboard");
  } catch (error) {
    next(error);
  }
});

router.put("/dashboard/:id", isAuthenticated, async (req, res, next) => {
  try {
    const { title, shortDescription, description } = req.body;
    await req.prisma.course.update({
      where: { id: req.params.id },
      data: { title, shortDescription, description: description || null },
    });
    res.redirect("/dashboard");
  } catch (error) {
    next(error);
  }
});

router.delete("/dashboard/:id", isAuthenticated, async (req, res, next) => {
  try {
    await req.prisma.course.delete({ where: { id: req.params.id } });
    res.redirect("/dashboard");
  } catch (error) {
    next(error);
  }
});

// ──────────── LESSON MANAGEMENT (Dashboard) ────────────

// Create lesson for a course
router.post("/dashboard/courses/:courseId/lessons", isAuthenticated, async (req, res, next) => {
  try {
    const { title, description } = req.body;
    const maxOrder = await req.prisma.lesson.aggregate({
      where: { courseId: req.params.courseId },
      _max: { order: true },
    });
    await req.prisma.lesson.create({
      data: {
        courseId: req.params.courseId,
        title: title?.trim() || "Nová lekce",
        description: description?.trim() || null,
        order: (maxOrder._max.order ?? -1) + 1,
      },
    });
    res.redirect("/dashboard");
  } catch (error) {
    next(error);
  }
});

// Duplicate lesson
router.post("/dashboard/lessons/:id/duplicate", isAuthenticated, async (req, res, next) => {
  try {
    const original = await req.prisma.lesson.findUnique({
      where: { id: req.params.id },
      include: { pages: { orderBy: { order: "asc" } } },
    });
    if (!original) return res.redirect("/dashboard");

    const maxOrder = await req.prisma.lesson.aggregate({
      where: { courseId: original.courseId },
      _max: { order: true },
    });

    await req.prisma.lesson.create({
      data: {
        courseId: original.courseId,
        title: `Copy of ${original.title}`,
        description: original.description,
        order: (maxOrder._max.order ?? -1) + 1,
        pages: {
          create: original.pages.map((p) => ({
            title: p.title,
            content: p.content,
            type: p.type,
            order: p.order,
            isPublished: p.isPublished,
          })),
        },
        liveSessions: { create: { currentState: "DRAFT" } },
      },
    });
    res.redirect("/dashboard");
  } catch (error) {
    next(error);
  }
});

// Delete lesson
router.post("/dashboard/lessons/:id/delete", isAuthenticated, async (req, res, next) => {
  try {
    await req.prisma.lesson.delete({ where: { id: req.params.id } });
    res.redirect("/dashboard");
  } catch (error) {
    next(error);
  }
});

// Lesson management page (pages + sessions)
router.get("/dashboard/lessons/:id", isAuthenticated, async (req, res, next) => {
  try {
    const lesson = await req.prisma.lesson.findUnique({
      where: { id: req.params.id },
      include: {
        course: true,
        pages: { orderBy: { order: "asc" } },
        liveSessions: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!lesson) return res.redirect("/dashboard");
    res.render("lesson-manage", { title: `${t("lessons", res.locals.lang)}: ${lesson.title}`, lesson, noIndex: true });
  } catch (error) {
    next(error);
  }
});

// Add page to lesson
router.post("/dashboard/lessons/:lessonId/pages", isAuthenticated, async (req, res, next) => {
  try {
    const { title, content, type, isPublished } = req.body;
    const maxOrder = await req.prisma.lessonPage.aggregate({
      where: { lessonId: req.params.lessonId },
      _max: { order: true },
    });
    await req.prisma.lessonPage.create({
      data: {
        lessonId: req.params.lessonId,
        title: title?.trim() || "Nová stránka",
        content: content || null,
        type: type || "text",
        order: (maxOrder._max.order ?? -1) + 1,
        isPublished: isPublished === "true" || isPublished === true,
      },
    });
    res.redirect(`/dashboard/lessons/${req.params.lessonId}`);
  } catch (error) {
    next(error);
  }
});

// Toggle page publish
router.post("/dashboard/pages/:id/toggle-publish", isAuthenticated, async (req, res, next) => {
  try {
    const page = await req.prisma.lessonPage.findUnique({ where: { id: req.params.id } });
    if (!page) return res.redirect("/dashboard");
    await req.prisma.lessonPage.update({
      where: { id: req.params.id },
      data: { isPublished: !page.isPublished },
    });
    res.redirect(`/dashboard/lessons/${page.lessonId}`);
  } catch (error) {
    next(error);
  }
});

// Delete page
router.post("/dashboard/pages/:id/delete", isAuthenticated, async (req, res, next) => {
  try {
    const page = await req.prisma.lessonPage.findUnique({ where: { id: req.params.id } });
    if (!page) return res.redirect("/dashboard");
    await req.prisma.lessonPage.delete({ where: { id: req.params.id } });
    res.redirect(`/dashboard/lessons/${page.lessonId}`);
  } catch (error) {
    next(error);
  }
});

// Create live session for a lesson
router.post("/dashboard/lessons/:lessonId/sessions", isAuthenticated, async (req, res, next) => {
  try {
    await req.prisma.liveSession.create({
      data: {
        lessonId: req.params.lessonId,
        currentState: "DRAFT",
        activeInstructorId: req.session.user?.username || null,
      },
    });
    res.redirect(`/dashboard/lessons/${req.params.lessonId}`);
  } catch (error) {
    next(error);
  }
});

// ──────────── CLASSROOM VIEWS ────────────

// Teacher live session view
router.get("/classroom/teacher/:sessionId", isAuthenticated, async (req, res, next) => {
  try {
    const session = await req.prisma.liveSession.findUnique({
      where: { id: req.params.sessionId },
      include: {
        lesson: {
          include: {
            course: true,
            pages: { orderBy: { order: "asc" } },
          },
        },
        activePage: true,
      },
    });
    if (!session) return res.status(404).render("error", { title: t("error", res.locals.lang), message: t("something_went_wrong", res.locals.lang) });
    res.render("teacher-live", {
      title: `${t("live_broadcast", res.locals.lang)} — ${session.lesson.title}`,
      session,
      lesson: session.lesson,
      noIndex: true,
    });
  } catch (error) {
    next(error);
  }
});

// Student classroom view
router.get("/classroom/student/:sessionId", async (req, res, next) => {
  try {
    const session = await req.prisma.liveSession.findUnique({
      where: { id: req.params.sessionId },
      include: {
        lesson: {
          include: {
            course: true,
            pages: { orderBy: { order: "asc" } },
          },
        },
        activePage: true,
      },
    });
    if (!session) return res.status(404).render("error", { title: t("error", res.locals.lang), message: t("something_went_wrong", res.locals.lang) });

    // Filter published pages for student
    const publishedPages = session.lesson.pages.filter((p) => p.isPublished);

    res.render("student-classroom", {
      title: `${t("lesson_content", res.locals.lang)} — ${session.lesson.title}`,
      session,
      lesson: session.lesson,
      publishedPages,
      noIndex: true,
    });
  } catch (error) {
    next(error);
  }
});

// ──────────── SESSION ANALYTICS (Historical) ────────────
router.get("/dashboard/sessions/:id/results", isAuthenticated, async (req, res, next) => {
  try {
    const session = await req.prisma.liveSession.findUnique({
      where: { id: req.params.id },
      include: {
        lesson: { include: { course: true } },
        quizResults: { include: { lessonPage: true }, orderBy: { submittedAt: "desc" } },
      },
    });
    if (!session) return res.redirect("/dashboard");

    // Analytics
    const byPage = new Map<string, { total: number; sum: number; title: string; scores: number[] }>();
    for (const r of session.quizResults) {
      const existing = byPage.get(r.lessonPageId) || { total: 0, sum: 0, title: r.lessonPage.title, scores: [] };
      existing.total += 1;
      existing.sum += r.score;
      existing.scores.push(r.score);
      byPage.set(r.lessonPageId, existing);
    }

    const analytics = Array.from(byPage.entries()).map(([pageId, data]) => ({
      pageId,
      pageTitle: data.title,
      totalSubmissions: data.total,
      averageScore: data.total > 0 ? Math.round((data.sum / data.total) * 100) / 100 : 0,
      minScore: data.scores.length > 0 ? Math.min(...data.scores) : 0,
      maxScore: data.scores.length > 0 ? Math.max(...data.scores) : 0,
    }));

    res.json({ session, analytics, results: session.quizResults });
  } catch (error) {
    next(error);
  }
});

export default router;
