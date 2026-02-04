const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Uploads directory
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Allowed file types and max size (30MB)
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mp3'];
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format'), false);
    }
  }
});

// Initialize SQLite database
const db = new Database('./data.db');

// Create courses table
db.exec(`
  CREATE TABLE IF NOT EXISTS courses (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    short_description TEXT
  )
`);

// Create materials table
db.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    uuid TEXT PRIMARY KEY,
    course_uuid TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    url TEXT,
    file_path TEXT,
    file_name TEXT,
    file_size INTEGER,
    mime_type TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (course_uuid) REFERENCES courses(uuid) ON DELETE CASCADE
  )
`);

// Create quizzes table
db.exec(`
  CREATE TABLE IF NOT EXISTS quizzes (
    uuid TEXT PRIMARY KEY,
    course_uuid TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (course_uuid) REFERENCES courses(uuid) ON DELETE CASCADE
  )
`);

// Create questions table
db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    uuid TEXT PRIMARY KEY,
    quiz_uuid TEXT NOT NULL,
    question TEXT NOT NULL,
    type TEXT NOT NULL,
    options TEXT NOT NULL,
    correct_index INTEGER,
    correct_indices TEXT,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (quiz_uuid) REFERENCES quizzes(uuid) ON DELETE CASCADE
  )
`);

// Create quiz_results table
db.exec(`
  CREATE TABLE IF NOT EXISTS quiz_results (
    uuid TEXT PRIMARY KEY,
    quiz_uuid TEXT NOT NULL,
    score INTEGER NOT NULL,
    max_score INTEGER NOT NULL,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (quiz_uuid) REFERENCES quizzes(uuid) ON DELETE CASCADE
  )
`);

// Create feed_entries table for informační kanál
db.exec(`
  CREATE TABLE IF NOT EXISTS feed_entries (
    uuid TEXT PRIMARY KEY,
    course_uuid TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    event TEXT,
    edited_at TEXT,
    deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (course_uuid) REFERENCES courses(uuid) ON DELETE CASCADE
  )
`);

// SSE clients per course
const sseClients = new Map();

// Seed data if empty
const count = db.prepare('SELECT COUNT(*) as count FROM courses').get();
if (count.count === 0) {
  const insert = db.prepare('INSERT INTO courses (uuid, name, description, short_description) VALUES (?, ?, ?, ?)');
  insert.run(uuidv4(), 'Úvod do programování', 'Tento kurz vás provede základy programování. Naučíte se proměnné, cykly, podmínky a funkce.', 'Základy programování pro začátečníky');
  insert.run(uuidv4(), 'Webový vývoj', 'Kompletní kurz webového vývoje zahrnující HTML, CSS a JavaScript.', 'HTML, CSS a JavaScript');
  insert.run(uuidv4(), 'Databáze a SQL', 'Naučte se pracovat s relačními databázemi a psát SQL dotazy.', 'Práce s relačními databázemi');
  console.log('Database seeded with sample courses');
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'tda26-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Serve static files from public (CSS, images, client JS)
app.use(express.static(path.join(__dirname, 'public')));

// Serve brand fonts from the provided brand manual folder (keeps original files in place)
app.use('/fonts/brand', express.static(path.join(__dirname, '..', '..', 'Think different Academy CZ-20251210T193908Z-3-001', 'Think different Academy CZ', 'TdA _ Fonts', 'static')));

// Set EJS as view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect('/login');
}

// API Auth middleware (returns 401 instead of redirect)
function requireApiAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// Helper to format material for API response
function formatMaterial(material) {
  const result = {
    uuid: material.uuid,
    name: material.name,
    description: material.description || '',
    type: material.type,
    createdAt: material.created_at
  };
  
  if (material.type === 'file') {
    result.fileUrl = `/uploads/${path.basename(material.file_path)}`;
    result.fileName = material.file_name;
    result.fileSize = material.file_size;
    result.mimeType = material.mime_type;
  } else {
    // type === 'url'
    result.url = material.url;
  }
  
  return result;
}

// Helper to format question for API response
function formatQuestion(question) {
  const result = {
    uuid: question.uuid,
    type: question.type,
    question: question.question,
    options: JSON.parse(question.options)
  };
  
  if (question.type === 'singleChoice') {
    result.correctIndex = question.correct_index;
  } else {
    result.correctIndices = JSON.parse(question.correct_indices || '[]');
  }
  
  return result;
}

// Helper to format quiz for API response
function formatQuiz(quiz) {
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_uuid = ? ORDER BY sort_order ASC').all(quiz.uuid);
  const completionCount = db.prepare('SELECT COUNT(*) as count FROM quiz_results WHERE quiz_uuid = ?').get(quiz.uuid).count;
  
  return {
    uuid: quiz.uuid,
    title: quiz.title,
    questions: questions.map(formatQuestion),
    completionCount: completionCount,
    createdAt: quiz.created_at
  };
}

// Helper to format course for API response
function formatCourse(course) {
  const materials = db.prepare('SELECT * FROM materials WHERE course_uuid = ? ORDER BY created_at DESC').all(course.uuid);
  const quizzes = db.prepare('SELECT * FROM quizzes WHERE course_uuid = ? ORDER BY created_at DESC').all(course.uuid);
  const feedEntries = db.prepare('SELECT * FROM feed_entries WHERE course_uuid = ? AND deleted = 0 ORDER BY created_at DESC').all(course.uuid);
  
  return {
    uuid: course.uuid,
    name: course.name,
    description: course.description || '',
    shortDescription: course.short_description || '',
    materials: materials.map(formatMaterial),
    quizzes: quizzes.map(formatQuiz),
    feed: feedEntries.map(formatFeedEntry)
  };
}

// Helper to format feed entry for API response
function formatFeedEntry(entry) {
  return {
    uuid: entry.uuid,
    type: entry.type,
    content: entry.content || '',
    event: entry.event || null,
    editedAt: entry.edited_at || null,
    createdAt: entry.created_at
  };
}

// Broadcast SSE event to all connected clients for a course
function sendSseToCourse(courseUuid, event, payload) {
  const clients = sseClients.get(courseUuid);
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

// Helper to create autogenerated feed entry and broadcast
function createAutoFeedEntry(courseUuid, eventName, content) {
  const entryUuid = uuidv4();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO feed_entries (uuid, course_uuid, type, content, event, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(entryUuid, courseUuid, 'AUTOGEN', content, eventName, createdAt);
  const entry = db.prepare('SELECT * FROM feed_entries WHERE uuid = ?').get(entryUuid);
  sendSseToCourse(courseUuid, 'new_entry', formatFeedEntry(entry));
  return entry;
}

// ============ API ROUTES ============

// GET /api - Phase 0 requirement
app.get('/api', (req, res) => {
  res.json({ organization: 'Student Cyber Games' });
});

// GET /api/courses - list all courses
app.get('/api/courses', (req, res) => {
  const courses = db.prepare('SELECT * FROM courses').all();
  res.json(courses.map(formatCourse));
});

// POST /api/courses - create new course
app.post('/api/courses', (req, res) => {
  const { name, description, shortDescription } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  
  const uuid = uuidv4();
  db.prepare('INSERT INTO courses (uuid, name, description, short_description) VALUES (?, ?, ?, ?)')
    .run(uuid, name, description || '', shortDescription || '');
  
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(uuid);
  res.status(201).json(formatCourse(course));
});

// GET /api/courses/:uuid - get single course
app.get('/api/courses/:uuid', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  res.json(formatCourse(course));
});

// PUT /api/courses/:uuid - update course
app.put('/api/courses/:uuid', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  const { name, description, shortDescription } = req.body;
  
  db.prepare('UPDATE courses SET name = ?, description = ?, short_description = ? WHERE uuid = ?')
    .run(
      name !== undefined ? name : course.name,
      description !== undefined ? description : course.description,
      shortDescription !== undefined ? shortDescription : course.short_description,
      req.params.uuid
    );
  
  const updated = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  res.json(formatCourse(updated));
});

// DELETE /api/courses/:uuid - delete course
app.delete('/api/courses/:uuid', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  // Delete associated materials files
  const materials = db.prepare('SELECT * FROM materials WHERE course_uuid = ?').all(req.params.uuid);
  materials.forEach(m => {
    if (m.file_path && fs.existsSync(m.file_path)) {
      fs.unlinkSync(m.file_path);
    }
  });
  
  db.prepare('DELETE FROM materials WHERE course_uuid = ?').run(req.params.uuid);
  db.prepare('DELETE FROM courses WHERE uuid = ?').run(req.params.uuid);
  res.status(204).send();
});

// ============ MATERIALS API ROUTES ============

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));

// GET /api/courses/:uuid/materials - list materials for a course
app.get('/api/courses/:uuid/materials', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  const materials = db.prepare('SELECT * FROM materials WHERE course_uuid = ? ORDER BY created_at DESC').all(req.params.uuid);
  res.json(materials.map(formatMaterial));
});

// POST /api/courses/:uuid/materials - create material
app.post('/api/courses/:uuid/materials', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 30MB.' });
      }
      if (err.message === 'Unsupported file format') {
        return res.status(400).json({ error: 'Unsupported file format' });
      }
      return res.status(400).json({ error: err.message });
    }
    
    const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
    
    if (!course) {
      // Clean up uploaded file if course not found
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Course not found' });
    }
    
    const { name, description, type, url } = req.body;
    
    if (!name) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Name is required' });
    }
    
    if (!type || !['file', 'url'].includes(type)) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Type must be "file" or "url"' });
    }
    
    if (type === 'url' && !url) {
      return res.status(400).json({ error: 'URL is required for url type' });
    }
    
    if (type === 'file' && !req.file) {
      return res.status(400).json({ error: 'File is required for file type' });
    }
    
    const materialUuid = uuidv4();
    
    if (type === 'file') {
      db.prepare(`
        INSERT INTO materials (uuid, course_uuid, type, name, description, file_path, file_name, file_size, mime_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        materialUuid,
        req.params.uuid,
        'file',
        name,
        description || '',
        req.file.path,
        req.file.originalname,
        req.file.size,
        req.file.mimetype
      );
    } else {
      db.prepare(`
        INSERT INTO materials (uuid, course_uuid, type, name, description, url)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        materialUuid,
        req.params.uuid,
        'url',
        name,
        description || '',
        url
      );
    }
    
    const material = db.prepare('SELECT * FROM materials WHERE uuid = ?').get(materialUuid);
    // Autogen feed entry for new material
    createAutoFeedEntry(req.params.uuid, 'material_added', `Přidán nový studijní materiál: ${name}`);
    res.status(201).json(formatMaterial(material));
  });
});

// GET /api/courses/:courseUuid/materials/:materialUuid - get single material
app.get('/api/courses/:courseUuid/materials/:materialUuid', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.materialUuid, req.params.courseUuid);
  
  if (!material) {
    return res.status(404).json({ error: 'Material not found' });
  }
  
  res.json(formatMaterial(material));
});

// PUT /api/courses/:courseUuid/materials/:materialUuid - update material
app.put('/api/courses/:courseUuid/materials/:materialUuid', (req, res) => {
  // Handle both JSON and multipart/form-data
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 30MB.' });
      }
      if (err.message === 'Unsupported file format') {
        return res.status(400).json({ error: 'Unsupported file format' });
      }
      return res.status(400).json({ error: err.message });
    }
    
    const material = db.prepare('SELECT * FROM materials WHERE uuid = ? AND course_uuid = ?')
      .get(req.params.materialUuid, req.params.courseUuid);
    
    if (!material) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Material not found' });
    }
    
    const { name, description, url } = req.body;
    
    if (material.type === 'url') {
      db.prepare('UPDATE materials SET name = ?, description = ?, url = ? WHERE uuid = ?')
        .run(
          name !== undefined ? name : material.name,
          description !== undefined ? description : material.description,
          url !== undefined ? url : material.url,
          req.params.materialUuid
        );
    } else {
      // File type - check if new file was uploaded
      if (req.file) {
        // Delete old file
        if (material.file_path && fs.existsSync(material.file_path)) {
          fs.unlinkSync(material.file_path);
        }
        // Update with new file
        db.prepare('UPDATE materials SET name = ?, description = ?, file_path = ?, file_name = ?, file_size = ?, mime_type = ? WHERE uuid = ?')
          .run(
            name !== undefined ? name : material.name,
            description !== undefined ? description : material.description,
            req.file.path,
            req.file.originalname,
            req.file.size,
            req.file.mimetype,
            req.params.materialUuid
          );
      } else {
        // Just update metadata
        db.prepare('UPDATE materials SET name = ?, description = ? WHERE uuid = ?')
          .run(
            name !== undefined ? name : material.name,
            description !== undefined ? description : material.description,
            req.params.materialUuid
          );
      }
    }
    
    const updated = db.prepare('SELECT * FROM materials WHERE uuid = ?').get(req.params.materialUuid);
    res.json(formatMaterial(updated));
  });
});

// DELETE /api/courses/:courseUuid/materials/:materialUuid - delete material
app.delete('/api/courses/:courseUuid/materials/:materialUuid', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.materialUuid, req.params.courseUuid);
  
  if (!material) {
    return res.status(404).json({ error: 'Material not found' });
  }
  
  // Delete file if it's a file type
  if (material.type === 'file' && material.file_path && fs.existsSync(material.file_path)) {
    fs.unlinkSync(material.file_path);
  }
  
  db.prepare('DELETE FROM materials WHERE uuid = ?').run(req.params.materialUuid);
  res.status(204).send();
});

// ============ QUIZZES API ROUTES ============

// GET /api/courses/:uuid/quizzes - list quizzes for a course
app.get('/api/courses/:uuid/quizzes', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  const quizzes = db.prepare('SELECT * FROM quizzes WHERE course_uuid = ? ORDER BY created_at DESC').all(req.params.uuid);
  res.json(quizzes.map(formatQuiz));
});

// POST /api/courses/:uuid/quizzes - create quiz
app.post('/api/courses/:uuid/quizzes', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  const { title, questions } = req.body;
  
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }
  
  const quizUuid = uuidv4();
  db.prepare('INSERT INTO quizzes (uuid, course_uuid, title) VALUES (?, ?, ?)')
    .run(quizUuid, req.params.uuid, title);
  
  // Add questions if provided
  if (questions && Array.isArray(questions)) {
    questions.forEach((q, qIndex) => {
      const questionUuid = uuidv4();
      db.prepare('INSERT INTO questions (uuid, quiz_uuid, question, type, options, correct_index, correct_indices, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          questionUuid,
          quizUuid,
          q.question,
          q.type || 'singleChoice',
          JSON.stringify(q.options || []),
          q.correctIndex !== undefined ? q.correctIndex : null,
          q.correctIndices ? JSON.stringify(q.correctIndices) : null,
          qIndex
        );
    });
  }
  
  const quiz = db.prepare('SELECT * FROM quizzes WHERE uuid = ?').get(quizUuid);
  // Autogen feed entry for new quiz
  createAutoFeedEntry(req.params.uuid, 'quiz_added', `Přidán nový kvíz: ${title}`);
  res.status(201).json(formatQuiz(quiz));
});

// GET /api/courses/:courseUuid/quizzes/:quizUuid - get single quiz
app.get('/api/courses/:courseUuid/quizzes/:quizUuid', (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.quizUuid, req.params.courseUuid);
  
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  
  res.json(formatQuiz(quiz));
});

// PUT /api/courses/:courseUuid/quizzes/:quizUuid - update quiz
app.put('/api/courses/:courseUuid/quizzes/:quizUuid', (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.quizUuid, req.params.courseUuid);
  
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  
  const { title, questions } = req.body;
  
  if (title !== undefined) {
    db.prepare('UPDATE quizzes SET title = ? WHERE uuid = ?')
      .run(title, req.params.quizUuid);
  }
  
  // If questions are provided, replace all questions
  if (questions && Array.isArray(questions)) {
    // Delete existing questions
    db.prepare('DELETE FROM questions WHERE quiz_uuid = ?').run(req.params.quizUuid);
    
    // Insert new questions
    questions.forEach((q, qIndex) => {
      const questionUuid = uuidv4();
      db.prepare('INSERT INTO questions (uuid, quiz_uuid, question, type, options, correct_index, correct_indices, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          questionUuid,
          req.params.quizUuid,
          q.question,
          q.type || 'singleChoice',
          JSON.stringify(q.options || []),
          q.correctIndex !== undefined ? q.correctIndex : null,
          q.correctIndices ? JSON.stringify(q.correctIndices) : null,
          qIndex
        );
    });
  }
  
  const updated = db.prepare('SELECT * FROM quizzes WHERE uuid = ?').get(req.params.quizUuid);
  res.json(formatQuiz(updated));
});

// DELETE /api/courses/:courseUuid/quizzes/:quizUuid - delete quiz
app.delete('/api/courses/:courseUuid/quizzes/:quizUuid', (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.quizUuid, req.params.courseUuid);
  
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  
  // Delete questions
  db.prepare('DELETE FROM questions WHERE quiz_uuid = ?').run(req.params.quizUuid);
  
  // Delete results
  db.prepare('DELETE FROM quiz_results WHERE quiz_uuid = ?').run(req.params.quizUuid);
  
  // Delete quiz
  db.prepare('DELETE FROM quizzes WHERE uuid = ?').run(req.params.quizUuid);
  res.status(204).send();
});

// POST /api/courses/:courseUuid/quizzes/:quizUuid/submit - submit quiz answers
app.post('/api/courses/:courseUuid/quizzes/:quizUuid/submit', (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.quizUuid, req.params.courseUuid);
  
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  
  const { answers } = req.body;
  
  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Answers array is required' });
  }
  
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_uuid = ? ORDER BY sort_order ASC').all(req.params.quizUuid);
  
  let score = 0;
  const maxScore = questions.length;
  
  questions.forEach(question => {
    const userAnswer = answers.find(a => a.uuid === question.uuid);
    
    if (!userAnswer) return;
    
    if (question.type === 'singleChoice') {
      // Single choice - check if the selected index is correct
      if (userAnswer.selectedIndex === question.correct_index) {
        score++;
      }
    } else if (question.type === 'multipleChoice') {
      // Multiple choice - check if selected indices exactly match correct indices
      const correctIndices = JSON.parse(question.correct_indices || '[]');
      const userIndices = userAnswer.selectedIndices || [];
      
      if (correctIndices.length === userIndices.length &&
          correctIndices.every(i => userIndices.includes(i)) &&
          userIndices.every(i => correctIndices.includes(i))) {
        score++;
      }
    }
  });
  
  // Save result
  const submittedAt = new Date().toISOString();
  const resultUuid = uuidv4();
  db.prepare('INSERT INTO quiz_results (uuid, quiz_uuid, score, max_score, submitted_at) VALUES (?, ?, ?, ?, ?)')
    .run(resultUuid, req.params.quizUuid, score, maxScore, submittedAt);
  
  res.json({
    quizUuid: req.params.quizUuid,
    score,
    maxScore,
    submittedAt
  });
});

// GET /api/courses/:courseUuid/quizzes/:quizUuid/results - get quiz results (lecturer only)
app.get('/api/courses/:courseUuid/quizzes/:quizUuid/results', requireApiAuth, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.quizUuid, req.params.courseUuid);
  
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  
  const results = db.prepare('SELECT * FROM quiz_results WHERE quiz_uuid = ? ORDER BY submitted_at DESC').all(req.params.quizUuid);
  
  res.json(results.map(r => ({
    uuid: r.uuid,
    score: r.score,
    maxScore: r.max_score,
    percentage: r.max_score > 0 ? Math.round((r.score / r.max_score) * 100) : 0,
    submittedAt: r.submitted_at
  })));
});

// ============ FEED API ROUTES ============

// GET /api/courses/:uuid/feed - list feed entries for a course
app.get('/api/courses/:uuid/feed', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  const entries = db.prepare('SELECT * FROM feed_entries WHERE course_uuid = ? AND deleted = 0 ORDER BY created_at DESC').all(req.params.uuid);
  res.json(entries.map(formatFeedEntry));
});

// POST /api/courses/:uuid/feed - create teacher post
app.post('/api/courses/:uuid/feed', requireApiAuth, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Field "text" is required' });
  }
  const entryUuid = uuidv4();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO feed_entries (uuid, course_uuid, type, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(entryUuid, req.params.uuid, 'TEACHER', text.trim(), createdAt);
  const entry = db.prepare('SELECT * FROM feed_entries WHERE uuid = ?').get(entryUuid);
  sendSseToCourse(req.params.uuid, 'new_entry', formatFeedEntry(entry));
  res.status(201).json(formatFeedEntry(entry));
});

// PATCH /api/courses/:uuid/feed/:entryUuid - edit teacher post
app.patch('/api/courses/:uuid/feed/:entryUuid', requireApiAuth, (req, res) => {
  const entry = db.prepare('SELECT * FROM feed_entries WHERE uuid = ? AND course_uuid = ? AND deleted = 0').get(req.params.entryUuid, req.params.uuid);
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  if (entry.type !== 'TEACHER') {
    return res.status(400).json({ error: 'Only teacher posts can be edited' });
  }
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Field "text" is required' });
  }
  const editedAt = new Date().toISOString();
  db.prepare('UPDATE feed_entries SET content = ?, edited_at = ? WHERE uuid = ?').run(text.trim(), editedAt, req.params.entryUuid);
  const updated = db.prepare('SELECT * FROM feed_entries WHERE uuid = ?').get(req.params.entryUuid);
  sendSseToCourse(req.params.uuid, 'updated_entry', formatFeedEntry(updated));
  res.json(formatFeedEntry(updated));
});

// DELETE /api/courses/:uuid/feed/:entryUuid - soft-delete entry
app.delete('/api/courses/:uuid/feed/:entryUuid', requireApiAuth, (req, res) => {
  const entry = db.prepare('SELECT * FROM feed_entries WHERE uuid = ? AND course_uuid = ? AND deleted = 0').get(req.params.entryUuid, req.params.uuid);
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  db.prepare('UPDATE feed_entries SET deleted = 1 WHERE uuid = ?').run(req.params.entryUuid);
  sendSseToCourse(req.params.uuid, 'deleted_entry', { uuid: req.params.entryUuid });
  res.status(204).send();
});

// GET /api/courses/:uuid/feed/stream - SSE stream for feed
app.get('/api/courses/:uuid/feed/stream', (req, res) => {
  const courseUuid = req.params.uuid;
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(courseUuid);
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  // Register client
  let clients = sseClients.get(courseUuid);
  if (!clients) {
    clients = new Set();
    sseClients.set(courseUuid, clients);
  }
  clients.add(res);

  // Send initial state
  const entries = db.prepare('SELECT * FROM feed_entries WHERE course_uuid = ? AND deleted = 0 ORDER BY created_at DESC').all(courseUuid);
  res.write('event: init\n');
  res.write(`data: ${JSON.stringify(entries.map(formatFeedEntry))}\n\n`);

  // Heartbeat every 25s
  const keepAlive = setInterval(() => {
    try { res.write(':\n\n'); } catch (e) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

// ============ PAGE ROUTES ============

// GET / - Home page with Hello TdA
app.get('/', (req, res) => {
  res.render('home', { user: req.session.user });
});

// GET /privacy-policy - Privacy Policy page
app.get('/privacy-policy', (req, res) => {
  res.render('privacy-policy', { user: req.session.user });
});

// GET /terms - Terms and Conditions page
app.get('/terms', (req, res) => {
  res.render('terms', { user: req.session.user });
});

// GET /courses - List all courses
app.get('/courses', (req, res) => {
  const search = req.query.search || '';
  let courses;
  
  if (search) {
    courses = db.prepare('SELECT * FROM courses WHERE name LIKE ?').all(`%${search}%`);
  } else {
    courses = db.prepare('SELECT * FROM courses').all();
  }
  
  res.render('courses', { courses, search, user: req.session.user });
});

// GET /courses/:uuid - Course detail
app.get('/courses/:uuid', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  
  if (!course) {
    return res.status(404).render('error', { message: 'Kurz nenalezen', user: req.session.user });
  }
  
  const rawMaterials = db.prepare('SELECT * FROM materials WHERE course_uuid = ? ORDER BY created_at DESC').all(req.params.uuid);
  // Add fileUrl to materials for template rendering
  const materials = rawMaterials.map(m => ({
    ...m,
    fileUrl: m.type === 'file' && m.file_path ? `/uploads/${path.basename(m.file_path)}` : null
  }));
  const quizzes = db.prepare('SELECT * FROM quizzes WHERE course_uuid = ? ORDER BY created_at DESC').all(req.params.uuid);
  
  // Add completion count to each quiz
  const quizzesWithCount = quizzes.map(quiz => {
    const count = db.prepare('SELECT COUNT(*) as count FROM quiz_results WHERE quiz_uuid = ?').get(quiz.uuid).count;
    return { ...quiz, completionCount: count };
  });
  
  res.render('course-detail', { course, materials, quizzes: quizzesWithCount, user: req.session.user });
});

// GET /login - Login page
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null, user: null });
});

// POST /login - Handle login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === 'lecturer' && password === 'TdA26!') {
    req.session.user = { username: 'lecturer', role: 'lecturer' };
    return res.redirect('/dashboard');
  }
  
  res.render('login', { error: 'Nesprávné přihlašovací údaje', user: null });
});

// GET /logout - Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// GET /dashboard - Dashboard (protected)
app.get('/dashboard', requireAuth, (req, res) => {
  const courses = db.prepare('SELECT * FROM courses').all();
  res.render('dashboard', { courses, user: req.session.user });
});

// POST /dashboard/courses - Create course from dashboard
app.post('/dashboard/courses', requireAuth, (req, res) => {
  const { name, description, shortDescription } = req.body;
  
  if (name) {
    const uuid = uuidv4();
    db.prepare('INSERT INTO courses (uuid, name, description, short_description) VALUES (?, ?, ?, ?)')
      .run(uuid, name, description || '', shortDescription || '');
  }
  
  res.redirect('/dashboard');
});

// POST /dashboard/courses/:uuid/delete - Delete course from dashboard
app.post('/dashboard/courses/:uuid/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM courses WHERE uuid = ?').run(req.params.uuid);
  res.redirect('/dashboard');
});

// POST /dashboard/courses/:uuid/edit - Edit course from dashboard
app.post('/dashboard/courses/:uuid/edit', requireAuth, (req, res) => {
  const { name, description, shortDescription } = req.body;
  
  db.prepare('UPDATE courses SET name = ?, description = ?, short_description = ? WHERE uuid = ?')
    .run(name, description || '', shortDescription || '', req.params.uuid);
  
  res.redirect('/dashboard');
});

// GET /dashboard/courses/:uuid - Course detail in dashboard
app.get('/dashboard/courses/:uuid', requireAuth, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
  
  if (!course) {
    return res.redirect('/dashboard');
  }
  
  const rawMaterials = db.prepare('SELECT * FROM materials WHERE course_uuid = ? ORDER BY created_at DESC').all(req.params.uuid);
  // Add fileUrl to materials for template rendering
  const materials = rawMaterials.map(m => ({
    ...m,
    fileUrl: m.type === 'file' && m.file_path ? `/uploads/${path.basename(m.file_path)}` : null
  }));
  const quizzes = db.prepare('SELECT * FROM quizzes WHERE course_uuid = ? ORDER BY created_at DESC').all(req.params.uuid);
  res.render('dashboard-course', { course, materials, quizzes, user: req.session.user });
});

// POST /dashboard/courses/:uuid/materials - Add material from dashboard
app.post('/dashboard/courses/:uuid/materials', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      // Redirect back with error - simplified for now
      return res.redirect(`/dashboard/courses/${req.params.uuid}?error=upload`);
    }
    
    const course = db.prepare('SELECT * FROM courses WHERE uuid = ?').get(req.params.uuid);
    if (!course) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.redirect('/dashboard');
    }
    
    const { name, description, type, url } = req.body;
    
    if (!name || !type) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.redirect(`/dashboard/courses/${req.params.uuid}?error=validation`);
    }
    
    const materialUuid = uuidv4();
    
    if (type === 'file' && req.file) {
      db.prepare(`
        INSERT INTO materials (uuid, course_uuid, type, name, description, file_path, file_name, file_size, mime_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        materialUuid,
        req.params.uuid,
        'file',
        name,
        description || '',
        req.file.path,
        req.file.originalname,
        req.file.size,
        req.file.mimetype
      );
    } else if (type === 'url' && url) {
      db.prepare(`
        INSERT INTO materials (uuid, course_uuid, type, name, description, url)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        materialUuid,
        req.params.uuid,
        'url',
        name,
        description || '',
        url
      );
    }
    
    res.redirect(`/dashboard/courses/${req.params.uuid}`);
  });
});

// POST /dashboard/courses/:uuid/materials/:materialUuid/delete - Delete material
app.post('/dashboard/courses/:uuid/materials/:materialUuid/delete', requireAuth, (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.materialUuid, req.params.uuid);
  
  if (material) {
    if (material.type === 'file' && material.file_path && fs.existsSync(material.file_path)) {
      fs.unlinkSync(material.file_path);
    }
    db.prepare('DELETE FROM materials WHERE uuid = ?').run(req.params.materialUuid);
  }
  
  res.redirect(`/dashboard/courses/${req.params.uuid}`);
});

// POST /dashboard/courses/:uuid/materials/:materialUuid/edit - Edit material
app.post('/dashboard/courses/:uuid/materials/:materialUuid/edit', requireAuth, (req, res) => {
  const { name, description, url } = req.body;
  const material = db.prepare('SELECT * FROM materials WHERE uuid = ? AND course_uuid = ?')
    .get(req.params.materialUuid, req.params.uuid);
  
  if (material) {
    if (material.type === 'url') {
      db.prepare('UPDATE materials SET name = ?, description = ?, url = ? WHERE uuid = ?')
        .run(name || material.name, description || '', url || material.url, req.params.materialUuid);
    } else {
      db.prepare('UPDATE materials SET name = ?, description = ? WHERE uuid = ?')
        .run(name || material.name, description || '', req.params.materialUuid);
    }
  }
  
  res.redirect(`/dashboard/courses/${req.params.uuid}`);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
