import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Track connected students per session room */
const roomPresence = new Map<string, Map<string, { socketId: string; pageId: string | null; joinedAt: Date }>>();

/** Track quiz submissions in real-time per session */
const roomQuizProgress = new Map<string, Map<string, Set<string>>>(); // sessionId -> pageId -> Set<studentId>

function getRoomName(sessionId: string) {
  return `session_${sessionId}`;
}

function getPresence(sessionId: string) {
  if (!roomPresence.has(sessionId)) {
    roomPresence.set(sessionId, new Map());
  }
  return roomPresence.get(sessionId)!;
}

function getQuizProgress(sessionId: string) {
  if (!roomQuizProgress.has(sessionId)) {
    roomQuizProgress.set(sessionId, new Map());
  }
  return roomQuizProgress.get(sessionId)!;
}

export function initSocketIO(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  const classroom = io.of("/classroom");

  classroom.on("connection", (socket: Socket) => {
    const { sessionId, role, studentId, instructorId } = socket.handshake.query as {
      sessionId?: string;
      role?: string;
      studentId?: string;
      instructorId?: string;
    };

    if (!sessionId) {
      socket.emit("error_msg", { message: "sessionId is required" });
      socket.disconnect();
      return;
    }

    const room = getRoomName(sessionId);
    socket.join(room);

    console.log(`[socket] ${role || "unknown"} joined room ${room} (socket: ${socket.id})`);

    // Track presence for students
    if (role === "student" && studentId) {
      const presence = getPresence(sessionId);
      presence.set(studentId, { socketId: socket.id, pageId: null, joinedAt: new Date() });
      emitStatsToInstructor(sessionId, room);
    }

    // ──────────── STATE RECOVERY ────────────
    socket.on("request_state_recovery", async () => {
      try {
        const session = await prisma.liveSession.findUnique({
          where: { id: sessionId },
          include: {
            activePage: true,
            lesson: {
              include: {
                pages: { orderBy: { order: "asc" } },
              },
            },
          },
        });

        if (!session) {
          socket.emit("error_msg", { message: "Session not found" });
          return;
        }

        // For students, filter out unpublished pages
        const pages = role === "student"
          ? session.lesson.pages.filter((p) => p.isPublished)
          : session.lesson.pages;

        socket.emit("state_recovery", {
          state: session.currentState,
          activePageId: session.activePageId,
          pages,
          lesson: {
            id: session.lesson.id,
            title: session.lesson.title,
            description: session.lesson.description,
          },
        });
      } catch (err) {
        console.error("[socket] state recovery error", err);
        socket.emit("error_msg", { message: "Failed to recover state" });
      }
    });

    // ──────────── INSTRUCTOR COMMANDS ────────────
    socket.on("instructor_command", async (payload: { command: string; value?: unknown }) => {
      if (role !== "instructor") {
        socket.emit("error_msg", { message: "Only instructors can send commands" });
        return;
      }

      try {
        const session = await prisma.liveSession.findUnique({ where: { id: sessionId } });
        if (!session) {
          socket.emit("error_msg", { message: "Session not found" });
          return;
        }

        // Instructor lock check
        if (session.activeInstructorId && session.activeInstructorId !== instructorId) {
          socket.emit("error_msg", { message: "Another instructor controls this session" });
          return;
        }

        switch (payload.command) {
          case "set_state": {
            const validStates = ["DRAFT", "SCHEDULED", "LIVE", "PAUSED", "ARCHIVED"];
            const newState = payload.value as string;
            if (!validStates.includes(newState)) {
              socket.emit("error_msg", { message: `Invalid state: ${newState}` });
              return;
            }

            const updateData: Record<string, unknown> = { currentState: newState };
            if (newState === "LIVE" && !session.startedAt) updateData.startedAt = new Date();
            if (newState === "ARCHIVED") updateData.endedAt = new Date();
            if (!session.activeInstructorId) updateData.activeInstructorId = instructorId;

            const updated = await prisma.liveSession.update({
              where: { id: sessionId },
              data: updateData,
            });

            classroom.to(room).emit("session_state_update", {
              state: updated.currentState,
              activePageId: updated.activePageId,
            });
            break;
          }

          case "set_page": {
            const pageId = payload.value as string;

            // Verify the page exists and is published before pushing students
            if (pageId) {
              const page = await prisma.lessonPage.findUnique({ where: { id: pageId } });
              if (!page) {
                socket.emit("error_msg", { message: "Page not found" });
                return;
              }
              if (!page.isPublished) {
                socket.emit("error_msg", { message: "Cannot push students to an unpublished page. Publish it first." });
                return;
              }
            }

            await prisma.liveSession.update({
              where: { id: sessionId },
              data: { activePageId: pageId || null },
            });

            classroom.to(room).emit("session_state_update", {
              state: session.currentState,
              activePageId: pageId,
            });

            classroom.to(room).emit("monitor_update", { pageId });
            break;
          }

          case "toggle_page_visibility": {
            const targetPageId = payload.value as string;
            if (!targetPageId) {
              socket.emit("error_msg", { message: "pageId is required" });
              return;
            }

            const page = await prisma.lessonPage.findUnique({ where: { id: targetPageId } });
            if (!page) {
              socket.emit("error_msg", { message: "Page not found" });
              return;
            }

            const updatedPage = await prisma.lessonPage.update({
              where: { id: targetPageId },
              data: { isPublished: !page.isPublished },
            });

            classroom.to(room).emit("page_visibility_update", {
              pageId: updatedPage.id,
              isPublished: updatedPage.isPublished,
            });
            break;
          }

          default:
            socket.emit("error_msg", { message: `Unknown command: ${payload.command}` });
        }
      } catch (err) {
        console.error("[socket] instructor_command error", err);
        socket.emit("error_msg", { message: "Command failed" });
      }
    });

    // ──────────── STUDENT PAGE ACKNOWLEDGMENT ────────────
    socket.on("student_ack_page", (payload: { pageId: string }) => {
      if (role !== "student" || !studentId) return;

      const presence = getPresence(sessionId);
      const entry = presence.get(studentId);
      if (entry) {
        entry.pageId = payload.pageId;
      }

      emitStatsToInstructor(sessionId, room);
    });

    // ──────────── QUIZ SUBMISSION ────────────
    socket.on("submit_quiz", async (payload: { pageId: string; answers: Record<string, unknown> }) => {
      if (!studentId) {
        socket.emit("error_msg", { message: "studentId is required for quiz submission" });
        return;
      }

      try {
        // Get the page to determine scoring
        const page = await prisma.lessonPage.findUnique({ where: { id: payload.pageId } });
        if (!page || page.type !== "quiz") {
          socket.emit("error_msg", { message: "Invalid quiz page" });
          return;
        }

        // Calculate score from answers (simple: check against content JSON)
        let score = 0;
        try {
          const quizData = page.content ? JSON.parse(page.content) : null;
          if (quizData?.questions && Array.isArray(quizData.questions)) {
            let correct = 0;
            for (const q of quizData.questions) {
              const studentAnswer = (payload.answers as Record<string, string>)[q.id];
              if (studentAnswer !== undefined && String(studentAnswer) === String(q.correctAnswer)) {
                correct++;
              }
            }
            score = quizData.questions.length > 0 ? (correct / quizData.questions.length) * 100 : 0;
          }
        } catch {
          // If content is not valid quiz JSON, score stays 0
        }

        const result = await prisma.quizResult.create({
          data: {
            liveSessionId: sessionId,
            lessonPageId: payload.pageId,
            studentId,
            score,
            answersJson: JSON.stringify(payload.answers),
          },
        });

        socket.emit("quiz_result", { score: result.score, resultId: result.id });

        // Track quiz progress
        const progress = getQuizProgress(sessionId);
        if (!progress.has(payload.pageId)) {
          progress.set(payload.pageId, new Set());
        }
        progress.get(payload.pageId)!.add(studentId);

        emitStatsToInstructor(sessionId, room);
      } catch (err) {
        console.error("[socket] submit_quiz error", err);
        socket.emit("error_msg", { message: "Quiz submission failed" });
      }
    });

    // ──────────── DISCONNECT ────────────
    socket.on("disconnect", () => {
      console.log(`[socket] ${role || "unknown"} left room ${room} (socket: ${socket.id})`);

      if (role === "student" && studentId) {
        const presence = getPresence(sessionId);
        presence.delete(studentId);
        emitStatsToInstructor(sessionId, room);
      }
    });
  });

  /** Emit real-time analytics to the instructor in the room */
  function emitStatsToInstructor(sessionId: string, room: string) {
    const presence = getPresence(sessionId);
    const quizProgress = getQuizProgress(sessionId);

    // Count students per page
    const pagePresence: Record<string, string[]> = {};
    for (const [sid, data] of presence.entries()) {
      if (data.pageId) {
        if (!pagePresence[data.pageId]) pagePresence[data.pageId] = [];
        pagePresence[data.pageId].push(sid);
      }
    }

    // Quiz submission counts per page
    const quizCounts: Record<string, number> = {};
    for (const [pageId, students] of quizProgress.entries()) {
      quizCounts[pageId] = students.size;
    }

    classroom.to(room).emit("stats_update_for_teacher", {
      onlineCount: presence.size,
      pagePresence,
      quizSubmissions: quizCounts,
      totalStudents: presence.size,
    });
  }

  return io;
}
