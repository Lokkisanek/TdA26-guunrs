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

router.get("/about", (_req, res) => {
  res.render("about", {
    title: t("about_title", res.locals.lang),
    noIndex: true,
  });
});

router.get("/profile", async (req, res, next) => {
  try {
    let profileUser = null;
    
    // Check for registered user
    if (req.session.userId) {
      profileUser = await req.prisma.user.findUnique({
        where: { id: req.session.userId },
      });
    } 
    // Check for hardcoded lecturer account
    else if (req.session.user && req.session.user.username === USERNAME) {
      profileUser = {
        firstName: "Lecturer",
        lastName: "Admin",
        email: "lecturer",
        isAdmin: true,
      };
    }
    
    res.render("profile", {
      title: t("profile_title", res.locals.lang),
      profileUser,
      noIndex: true,
    });
  } catch (error) {
    next(error);
  }
});

router
  .route("/profile/edit")
  .get(async (req, res, next) => {
    try {
      // Only registered users can edit profile
      if (!req.session.userId) {
        return res.redirect("/profile");
      }

      const profileUser = await req.prisma.user.findUnique({
        where: { id: req.session.userId },
      });

      if (!profileUser) {
        return res.redirect("/profile");
      }

      res.render("profile-edit", {
        title: t("edit_profile", res.locals.lang),
        profileUser,
        noIndex: true,
      });
    } catch (error) {
      next(error);
    }
  })
  .post(async (req, res, next) => {
    try {
      if (!req.session.userId) {
        return res.redirect("/profile");
      }

      const { firstName, lastName, email, currentPassword, newPassword, confirmPassword } = req.body;
      const lang = res.locals.lang;

      const profileUser = await req.prisma.user.findUnique({
        where: { id: req.session.userId },
      });

      if (!profileUser) {
        return res.redirect("/profile");
      }

      // Check if email is already taken by another user
      const existingUser = await req.prisma.user.findFirst({
        where: {
          email: email.toLowerCase().trim(),
          NOT: { id: req.session.userId },
        },
      });

      if (existingUser) {
        return res.status(400).render("profile-edit", {
          title: t("edit_profile", lang),
          error: t("email_already_exists", lang),
          profileUser: { ...profileUser, firstName, lastName, email },
          noIndex: true,
        });
      }

      // Prepare update data
      const updateData: any = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.toLowerCase().trim(),
      };

      // Handle password change
      if (newPassword) {
        if (newPassword !== confirmPassword) {
          return res.status(400).render("profile-edit", {
            title: t("edit_profile", lang),
            error: t("passwords_not_match", lang),
            profileUser: { ...profileUser, firstName, lastName, email },
            noIndex: true,
          });
        }

        const crypto = await import("crypto");
        const hashedCurrentPassword = crypto.createHash("sha256").update(currentPassword || "").digest("hex");

        if (hashedCurrentPassword !== profileUser.password) {
          return res.status(400).render("profile-edit", {
            title: t("edit_profile", lang),
            error: t("incorrect_password", lang),
            profileUser: { ...profileUser, firstName, lastName, email },
            noIndex: true,
          });
        }

        updateData.password = crypto.createHash("sha256").update(newPassword).digest("hex");
      }

      // Update user
      const updatedUser = await req.prisma.user.update({
        where: { id: req.session.userId },
        data: updateData,
      });

      // Update session
      req.session.user = {
        username: updatedUser.email,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        isAdmin: updatedUser.isAdmin,
      };

      res.render("profile-edit", {
        title: t("edit_profile", lang),
        profileUser: updatedUser,
        success: t("profile_updated", lang),
        noIndex: true,
      });
    } catch (error) {
      next(error);
    }
  });

router
  .route("/register")
  .get((req, res) => {
    if (req.session.userId) {
      return res.redirect("/courses");
    }
    res.render("register", {
      title: t("register_title", res.locals.lang),
      noIndex: true,
    });
  })
  .post(async (req, res, next) => {
    try {
      const { firstName, lastName, email, password, confirmPassword, acceptTerms } = req.body;
      const lang = res.locals.lang;

      // Validation
      if (!acceptTerms) {
        return res.status(400).render("register", {
          title: t("register_title", lang),
          error: t("must_accept_terms", lang),
          firstName,
          lastName,
          email,
          noIndex: true,
        });
      }

      if (password !== confirmPassword) {
        return res.status(400).render("register", {
          title: t("register_title", lang),
          error: t("passwords_not_match", lang),
          firstName,
          lastName,
          email,
          noIndex: true,
        });
      }

      // Check if email already exists
      const existingUser = await req.prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
      });

      if (existingUser) {
        return res.status(400).render("register", {
          title: t("register_title", lang),
          error: t("email_already_exists", lang),
          firstName,
          lastName,
          email,
          noIndex: true,
        });
      }

      // Create user (simple hash for demo - in production use bcrypt)
      const crypto = await import("crypto");
      const hashedPassword = crypto.createHash("sha256").update(password).digest("hex");

      const user = await req.prisma.user.create({
        data: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.toLowerCase().trim(),
          password: hashedPassword,
          isAdmin: false,
        },
      });

      // Auto-login
      req.session.userId = user.id;
      req.session.user = { username: user.email, firstName: user.firstName, lastName: user.lastName, isAdmin: false };
      res.redirect("/courses");
    } catch (error) {
      next(error);
    }
  });

router.get("/courses", async (req, res, next) => {
  try {
    const search = req.query.search?.toString().trim() ?? "";
    const isAdmin = req.session.user?.isAdmin;
    const isLecturer = req.session.user?.isLecturer;
    const visibilityFilter = (isAdmin || isLecturer) ? {} : { visibility: "LIVE" };
    const courses = await req.prisma.course.findMany({
      where: search
        ? {
            ...visibilityFilter,
            OR: [
              { title: { contains: search } },
              { shortDescription: { contains: search } },
            ],
          }
        : visibilityFilter,
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
    const isAdmin = req.session.user?.isAdmin;
    const isLecturer = req.session.user?.isLecturer;
    // Hide non-LIVE courses from public users
    if (course && course.visibility !== "LIVE" && !isAdmin && !isLecturer) {
      return res.status(404).render("course-detail", { title: t("course_not_found", lang), course: null });
    }
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
    if (req.session.userId || req.session.user) {
      return res.redirect("/courses");
    }
    res.render("login", { title: t("login_title", res.locals.lang), error: null, noIndex: true });
  })
  .post(async (req, res, next) => {
    try {
      const { username, password } = req.body;
      const lang = res.locals.lang;

      // Check hardcoded admin first
      if (username === USERNAME && password === PASSWORD) {
        req.session.user = { username, isAdmin: true };
        const redirectTo = req.session.returnTo || "/dashboard";
        delete req.session.returnTo;
        return res.redirect(redirectTo);
      }

      // Check registered users
      const crypto = await import("crypto");
      const hashedPassword = crypto.createHash("sha256").update(password).digest("hex");

      const user = await req.prisma.user.findFirst({
        where: {
          OR: [
            { email: username.toLowerCase().trim() },
          ],
          password: hashedPassword,
        },
      });

      if (user) {
        req.session.userId = user.id;
        req.session.user = {
          username: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          isAdmin: user.isAdmin,
          isLecturer: (user as any).isLecturer || false,
        };
        const redirectTo = req.session.returnTo || (user.isAdmin || (user as any).isLecturer ? "/dashboard" : "/courses");
        delete req.session.returnTo;
        return res.redirect(redirectTo);
      }

      res.status(401).render("login", {
        title: t("login_title", lang),
        error: t("invalid_credentials", lang),
        noIndex: true,
      });
    } catch (error) {
      next(error);
    }
  });

router.post("/logout", isAuthenticated, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// ──────────── USER MANAGEMENT ────────────
router.get("/dashboard/users", isAuthenticated, async (req, res, next) => {
  try {
    if (!req.session.user?.isAdmin) return res.redirect("/dashboard");
    const users = await req.prisma.user.findMany({ orderBy: { createdAt: "desc" } });
    res.render("user-management", { title: t("user_management", res.locals.lang), users, noIndex: true });
  } catch (error) {
    next(error);
  }
});

router.post("/dashboard/users/:id/role", isAuthenticated, async (req, res, next) => {
  try {
    if (!req.session.user?.isAdmin) return res.redirect("/dashboard");
    const isLecturer = req.body.isLecturer === "true";
    await req.prisma.user.update({
      where: { id: req.params.id },
      data: { isLecturer },
    });
    res.redirect("/dashboard/users");
  } catch (error) {
    next(error);
  }
});

// ──────────── DASHBOARD ────────────
router.get("/dashboard", isAuthenticated, async (req, res, next) => {
  try {
    const isAdmin = req.session.user?.isAdmin;
    const isLecturer = req.session.user?.isLecturer;
    const userId = req.session.userId;

    // Only admin and lecturers can access the dashboard
    if (!isAdmin && !isLecturer) return res.redirect("/courses");

    // Lecturers only see their own courses; admin sees all
    const whereClause = (isAdmin) ? {} : { ownerId: userId || "__none__" };

    const courses = await req.prisma.course.findMany({
      where: whereClause,
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
      data: { title, shortDescription, description: description || null, ownerId: req.session.userId || null },
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

// ──────────── COURSE EDITOR ────────────
router.get("/dashboard/edit/courses/:id", isAuthenticated, async (req, res, next) => {
  try {
    const course = await req.prisma.course.findUnique({
      where: { id: req.params.id },
      include: {
        lessons: {
          orderBy: { order: "asc" },
          include: {
            _count: { select: { pages: true, liveSessions: true } },
            liveSessions: { orderBy: { createdAt: "desc" } },
          },
        },
      },
    });
    if (!course) return res.status(404).render("error", { title: t("error", res.locals.lang), message: t("course_not_found", res.locals.lang) });
    res.render("course-edit", { title: `${t("edit", res.locals.lang)}: ${course.title}`, course, noIndex: true });
  } catch (error) {
    next(error);
  }
});

router.post("/dashboard/edit/courses/:id", isAuthenticated, async (req, res, next) => {
  try {
    const { title, shortDescription, description } = req.body;
    await req.prisma.course.update({
      where: { id: req.params.id },
      data: { title, shortDescription, description: description || null },
    });
    res.redirect(`/dashboard/edit/courses/${req.params.id}`);
  } catch (error) {
    next(error);
  }
});

router.post("/dashboard/edit/courses/:id/visibility", isAuthenticated, async (req, res, next) => {
  try {
    const { visibility, scheduleEnabled, scheduledAt, scheduledChange } = req.body;
    const data: any = { visibility: visibility || "PREPARATION" };
    if (scheduleEnabled && scheduledAt && scheduledChange) {
      data.scheduledAt = new Date(scheduledAt);
      data.scheduledChange = scheduledChange;
    } else {
      data.scheduledAt = null;
      data.scheduledChange = null;
    }
    await req.prisma.course.update({
      where: { id: req.params.id },
      data,
    });
    res.redirect(`/dashboard/edit/courses/${req.params.id}`);
  } catch (error) {
    next(error);
  }
});

// ──────────── COURSE STATISTICS EXPORT ────────────
router.get("/dashboard/edit/courses/:id/stats.csv", isAuthenticated, async (req, res, next) => {
  try {
    const course = await req.prisma.course.findUnique({
      where: { id: req.params.id },
      include: {
        lessons: {
          orderBy: { order: "asc" },
          include: {
            pages: { orderBy: { order: "asc" } },
            liveSessions: {
              include: {
                quizResults: true,
              },
            },
          },
        },
      },
    });
    if (!course) return res.status(404).send("Not found");

    const rows: string[][] = [];
    rows.push(["Lesson", "Session ID", "Session State", "Started At", "Ended At", "Student ID", "Quiz Page", "Score", "Submitted At"]);

    for (const lesson of course.lessons) {
      if (lesson.liveSessions.length === 0) {
        rows.push([lesson.title, "", "", "", "", "", "", "", ""]);
        continue;
      }
      for (const session of lesson.liveSessions) {
        if (session.quizResults.length === 0) {
          rows.push([
            lesson.title,
            session.id,
            session.currentState,
            session.startedAt ? new Date(session.startedAt).toISOString() : "",
            session.endedAt ? new Date(session.endedAt).toISOString() : "",
            "", "", "", "",
          ]);
          continue;
        }
        for (const qr of session.quizResults) {
          const page = lesson.pages.find((p: any) => p.id === qr.lessonPageId);
          rows.push([
            lesson.title,
            session.id,
            session.currentState,
            session.startedAt ? new Date(session.startedAt).toISOString() : "",
            session.endedAt ? new Date(session.endedAt).toISOString() : "",
            qr.studentId,
            page ? page.title : qr.lessonPageId,
            String(qr.score),
            new Date(qr.submittedAt).toISOString(),
          ]);
        }
      }
    }

    const csv = rows.map(r => r.map(c => `"${(c || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const filename = `${course.title.replace(/[^a-zA-Z0-9]/g, "_")}_stats.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv); // BOM for Excel compat
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
    const referer = req.get("Referer") || "";
    if (referer.includes("/dashboard/edit/courses/")) {
      return res.redirect(referer);
    }
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
    const referer = req.get("Referer") || "";
    if (referer.includes("/dashboard/edit/courses/")) {
      return res.redirect(referer);
    }
    res.redirect("/dashboard");
  } catch (error) {
    next(error);
  }
});

// Delete lesson
router.post("/dashboard/lessons/:id/delete", isAuthenticated, async (req, res, next) => {
  try {
    const lesson = await req.prisma.lesson.findUnique({ where: { id: req.params.id }, select: { courseId: true } });
    await req.prisma.lesson.delete({ where: { id: req.params.id } });
    const referer = req.get("Referer") || "";
    if (referer.includes("/dashboard/edit/courses/") && lesson) {
      return res.redirect(`/dashboard/edit/courses/${lesson.courseId}`);
    }
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
    const { title, content, type } = req.body;
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
        isPublished: true,
      },
    });
    const referer = req.headers.referer || `/dashboard/lessons/${req.params.lessonId}`;
    res.redirect(referer);
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
