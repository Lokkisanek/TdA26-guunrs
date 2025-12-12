import { Router } from "express";
import "express-session";
import { isAuthenticated } from "../middleware/auth.js";

const USERNAME = "lecturer";
const PASSWORD = "TdA26!";

const router = Router();

router.get("/", (_req, res) => {
  res.render("home", { title: "TdA Academy" });
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

    res.render("courses", { title: "Kurzy", courses, search });
  } catch (error) {
    next(error);
  }
});

router.get("/courses/:id", async (req, res, next) => {
  try {
    const course = await req.prisma.course.findUnique({ where: { id: req.params.id } });
    res.status(course ? 200 : 404).render("course-detail", {
      title: course ? course.title : "Kurz nenalezen",
      course,
    });
  } catch (error) {
    next(error);
  }
});

router
  .route("/login")
  .get((req, res) => {
    res.render("login", { title: "Přihlášení", error: null });
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
      title: "Přihlášení",
      error: "Neplatné přihlašovací údaje",
    });
  });

router.post("/logout", isAuthenticated, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

router.get("/dashboard", isAuthenticated, async (req, res, next) => {
  try {
    const courses = await req.prisma.course.findMany({ orderBy: { createdAt: "desc" } });
    res.render("dashboard", { title: "Dashboard", courses });
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

export default router;
