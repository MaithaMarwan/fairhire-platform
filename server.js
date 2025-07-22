// server.js - FairHire Recruitment Platform Backend
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const winston = require('winston');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Logging setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'app.log' })
    ]
});

// Security and Performance Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
}));
app.use(compression());
app.use(cors({
    origin: process.env.FRONTEND_URL || true,
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Stricter rate limiting for file uploads
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5,
    message: { error: 'Too many file uploads, please wait' }
});

// Database connection with retry logic
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
    logger.info('Database connected successfully');
});

pool.on('error', (err) => {
    logger.error('Database connection error:', err);
});

// Email transporter
const emailTransporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Verify email configuration
emailTransporter.verify((error, success) => {
    if (error) {
        logger.warn('Email configuration issue:', error.message);
    } else {
        logger.info('Email service ready');
    }
});

// Multer configuration for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF, DOC, and DOCX files are allowed.'));
        }
    }
});

// JWT Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Bias reminder middleware
const biasReminderMiddleware = (req, res, next) => {
    if (req.path.includes('/applications') && req.method === 'GET') {
        res.set('X-Bias-Reminder', 'Focus on qualifications only. Personal details are hidden for fair evaluation.');
    }
    next();
};

app.use(biasReminderMiddleware);

// Database initialization
async function initializeDatabase() {
    try {
        logger.info('Initializing database...');
        
        // Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'recruiter',
                name VARCHAR(255),
                department VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            );
        `);

        // Job descriptions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS job_descriptions (
                id SERIAL PRIMARY KEY,
                job_key VARCHAR(100) UNIQUE NOT NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT NOT NULL,
                requirements TEXT[] NOT NULL,
                department VARCHAR(100),
                level VARCHAR(50),
                salary_range VARCHAR(100),
                location VARCHAR(255),
                is_active BOOLEAN DEFAULT true,
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Applications table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS applications (
                id SERIAL PRIMARY KEY,
                job_key VARCHAR(100),
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                cover_letter TEXT,
                file_name VARCHAR(255) NOT NULL,
                file_size INTEGER NOT NULL,
                file_type VARCHAR(100) NOT NULL,
                file_url VARCHAR(500),
                cv_content JSONB,
                ai_score INTEGER,
                ai_explanation TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                anonymized_id VARCHAR(20) UNIQUE NOT NULL,
                submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP,
                reviewed_by INTEGER REFERENCES users(id)
            );
        `);

        // Audit logs table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                action VARCHAR(100) NOT NULL,
                resource_type VARCHAR(50),
                resource_id INTEGER,
                details JSONB,
                ip_address INET,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create indexes for performance
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_applications_job_key ON applications(job_key);
            CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
            CREATE INDEX IF NOT EXISTS idx_applications_submitted_at ON applications(submitted_at);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
        `);

        // Insert default data
        await insertDefaultData();
        
        logger.info('Database initialized successfully');
    } catch (error) {
        logger.error('Database initialization error:', error);
        throw error;
    }
}

async function insertDefaultData() {
    const defaultJobs = [
        {
            job_key: 'software-engineer',
            title: 'Software Engineer',
            description: 'We are looking for a skilled software engineer with experience in full-stack development, proficiency in JavaScript, Python, or Java, knowledge of databases and cloud platforms, strong problem-solving skills, and experience with version control systems.',
            requirements: ['3+ years experience', 'Bachelor degree in CS or related field', 'JavaScript/Python/Java proficiency', 'Database knowledge', 'Cloud platforms experience'],
            department: 'Engineering',
            level: 'Mid-Level',
            location: 'Remote'
        },
        {
            job_key: 'data-scientist',
            title: 'Data Scientist',
            description: 'Seeking a data scientist with expertise in machine learning, statistical analysis, Python/R programming, data visualization tools, and experience with big data technologies.',
            requirements: ['Masters in Data Science/Statistics', 'Python/R programming', 'Machine learning expertise', 'SQL proficiency', 'Data visualization tools'],
            department: 'Data & Analytics',
            level: 'Mid-Level',
            location: 'Hybrid - New York'
        },
        {
            job_key: 'product-manager',
            title: 'Product Manager',
            description: 'Looking for a product manager with experience in product strategy, user research, cross-functional team leadership, and agile methodologies.',
            requirements: ['5+ years product management', 'MBA preferred', 'Agile methodology', 'User research experience', 'Leadership skills'],
            department: 'Product',
            level: 'Senior-Level',
            location: 'San Francisco, CA'
        },
        {
            job_key: 'marketing-manager',
            title: 'Marketing Manager',
            description: 'Seeking a marketing manager with digital marketing expertise, campaign management experience, analytics skills, and brand management knowledge.',
            requirements: ['3+ years marketing experience', 'Digital marketing expertise', 'Analytics tools proficiency', 'Campaign management', 'Brand strategy'],
            department: 'Marketing',
            level: 'Mid-Level',
            location: 'Remote'
        },
        {
            job_key: 'sales-representative',
            title: 'Sales Representative',
            description: 'Looking for a sales representative with B2B sales experience, relationship building skills, CRM knowledge, and strong communication abilities.',
            requirements: ['2+ years B2B sales', 'CRM experience', 'Communication skills', 'Relationship building', 'Target achievement record'],
            department: 'Sales',
            level: 'Entry-Level',
            location: 'Boston, MA'
        }
    ];

    for (const job of defaultJobs) {
        try {
            await pool.query(`
                INSERT INTO job_descriptions (job_key, title, description, requirements, department, level, location)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (job_key) DO NOTHING
            `, [job.job_key, job.title, job.description, job.requirements, job.department, job.level, job.location]);
        } catch (error) {
            logger.warn(`Job ${job.job_key} already exists`);
        }
    }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
    });
});

// Authentication endpoints
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name, department } = req.body;
        
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Email, password, and name are required' });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Password validation
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existingUser.rows.length > 0) {
            return res.status(409).json({ error: 'User already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const result = await pool.query(`
            INSERT INTO users (email, password_hash, name, department)
            VALUES ($1, $2, $3, $4)
            RETURNING id, email, name, department, role, created_at
        `, [email.toLowerCase(), passwordHash, name, department]);

        const user = result.rows[0];
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role }, 
            process.env.JWT_SECRET || 'fallback-secret-key', 
            { expiresIn: '24h' }
        );

        // Log registration
        await logAuditEvent(user.id, 'REGISTER', 'user', user.id, { name, department }, req.ip);

        res.status(201).json({ 
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                department: user.department,
                role: user.role
            }, 
            token 
        });
    } catch (error) {
        logger.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email.toLowerCase()]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role }, 
            process.env.JWT_SECRET || 'fallback-secret-key', 
            { expiresIn: '24h' }
        );

        // Log login
        await logAuditEvent(user.id, 'LOGIN', 'user', user.id, {}, req.ip);

        res.json({ 
            user: { 
                id: user.id, 
                email: user.email, 
                name: user.name, 
                department: user.department, 
                role: user.role 
            }, 
            token 
        });
    } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Job endpoints
app.get('/api/jobs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT job_key, title, description, requirements, department, level, location, is_active, salary_range
            FROM job_descriptions 
            WHERE is_active = true
            ORDER BY title
        `);
        res.json(result.rows);
    } catch (error) {
        logger.error('Get jobs error:', error);
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});

app.get('/api/jobs/:jobKey', async (req, res) => {
    try {
        const { jobKey } = req.params;
        const result = await pool.query('SELECT * FROM job_descriptions WHERE job_key = $1', [jobKey]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        logger.error('Get job error:', error);
        res.status(500).json({ error: 'Failed to fetch job' });
    }
});

app.put('/api/jobs/:jobKey', authenticateToken, async (req, res) => {
    try {
        const { jobKey } = req.params;
        const { title, description, requirements, department, level, salary_range, location, is_active } = req.body;

        const result = await pool.query(`
            UPDATE job_descriptions 
            SET title = $1, description = $2, requirements = $3, department = $4, 
                level = $5, salary_range = $6, location = $7, is_active = $8, updated_at = CURRENT_TIMESTAMP
            WHERE job_key = $9
            RETURNING *
        `, [title, description, requirements, department, level, salary_range, location, is_active, jobKey]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Log the update
        await logAuditEvent(req.user.userId, 'UPDATE', 'job_description', result.rows[0].id, { jobKey, changes: req.body }, req.ip);

        res.json(result.rows[0]);
    } catch (error) {
        logger.error('Update job error:', error);
        res.status(500).json({ error: 'Failed to update job' });
    }
});

// Application submission with file upload
app.post('/api/applications', uploadLimiter, upload.single('cvFile'), async (req, res) => {
    try {
        const { jobKey, email, phone, coverLetter } = req.body;
        const file = req.file;

        // Validation
        if (!jobKey || !email || !phone || !file) {
            return res.status(400).json({ error: 'Job position, email, phone, and CV file are required' });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Phone validation (basic)
        if (phone.length < 10) {
            return res.status(400).json({ error: 'Phone number must be at least 10 digits' });
        }

        // Verify job exists and is active
        const jobResult = await pool.query('SELECT id, title FROM job_descriptions WHERE job_key = $1 AND is_active = true', [jobKey]);
        if (jobResult.rows.length === 0) {
            return res.status(404).json({ error: 'Job position not found or inactive' });
        }

        // Check for duplicate applications (same email for same job)
        const duplicateCheck = await pool.query('SELECT id FROM applications WHERE job_key = $1 AND email = $2', [jobKey, email.toLowerCase()]);
        if (duplicateCheck.rows.length > 0) {
            return res.status(409).json({ error: 'You have already applied for this position' });
        }

        // For demo purposes, we'll store file reference only
        const fileUrl = `stored_cv_${Date.now()}_${file.originalname}`;

        // Extract CV content using AI simulation
        const cvContent = await extractCVContent(file.buffer, file.originalname);

        // Generate anonymized ID for bias prevention
        const anonymizedId = 'APP_' + Math.random().toString(36).substring(2, 8).toUpperCase();

        // Save application to database
        const result = await pool.query(`
            INSERT INTO applications (
                job_key, email, phone, cover_letter, file_name, file_size, 
                file_type, file_url, cv_content, anonymized_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, anonymized_id, submitted_at
        `, [
            jobKey, email.toLowerCase(), phone, coverLetter, file.originalname, 
            file.size, file.mimetype, fileUrl, JSON.stringify(cvContent), anonymizedId
        ]);

        // Send confirmation email to applicant
        try {
            await sendConfirmationEmail(email, jobResult.rows[0].title, anonymizedId);
        } catch (emailError) {
            logger.warn('Confirmation email failed:', emailError.message);
            // Don't fail the application submission if email fails
        }

        logger.info(`New application submitted: ${anonymizedId} for ${jobKey}`);

        res.status(201).json({
            success: true,
            applicationId: result.rows[0].id,
            anonymizedId: result.rows[0].anonymized_id,
            submittedAt: result.rows[0].submitted_at,
            message: 'Application submitted successfully! You will receive a confirmation email shortly.'
        });

    } catch (error) {
        logger.error('Application submission error:', error);
        
        if (error instanceof multer.MulterError) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
            }
        }
        
        res.status(500).json({ error: 'Failed to submit application' });
    }
});

// Get applications for recruiters
app.get('/api/applications', authenticateToken, async (req, res) => {
    try {
        const { jobKey, status, page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT a.*, j.title as job_title 
            FROM applications a
            JOIN job_descriptions j ON a.job_key = j.job_key
            WHERE 1=1
        `;
        const params = [];

        if (jobKey) {
            params.push(jobKey);
            query += ` AND a.job_key = $${params.length}`;
        }

        if (status) {
            params.push(status);
            query += ` AND a.status = $${params.length}`;
        }

        query += ` ORDER BY a.submitted_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        // Remove sensitive information for bias prevention
        const sanitizedApplications = result.rows.map(app => ({
            id: app.id,
            anonymized_id: app.anonymized_id,
            job_key: app.job_key,
            job_title: app.job_title,
            file_name: app.file_name,
            file_size: app.file_size,
            cv_content: app.cv_content,
            ai_score: app.ai_score,
            ai_explanation: app.ai_explanation,
            status: app.status,
            submitted_at: app.submitted_at,
            reviewed_at: app.reviewed_at,
            // Hide email and phone until after decision
            contact_info_hidden: true
        }));

        res.json(sanitizedApplications);
    } catch (error) {
        logger.error('Get applications error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// AI ranking endpoint
app.post('/api/applications/rank', authenticateToken, async (req, res) => {
    try {
        const { jobKey } = req.body;

        if (!jobKey) {
            return res.status(400).json({ error: 'Job key is required' });
        }

        // Get job description
        const jobResult = await pool.query('SELECT * FROM job_descriptions WHERE job_key = $1', [jobKey]);
        if (jobResult.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const jobDescription = jobResult.rows[0];

        // Get pending applications for this job
        const applicationsResult = await pool.query(`
            SELECT * FROM applications 
            WHERE job_key = $1 AND status = 'pending' AND ai_score IS NULL
        `, [jobKey]);

        const applications = applicationsResult.rows;

        if (applications.length === 0) {
            return res.status(400).json({ error: 'No pending applications to rank' });
        }

        // Process each application with AI
        const rankedApplications = [];
        for (const app of applications) {
            const analysis = await analyzeApplication(app.cv_content, jobDescription);
            
            // Update application with AI score and explanation
            await pool.query(`
                UPDATE applications 
                SET ai_score = $1, ai_explanation = $2 
                WHERE id = $3
            `, [analysis.score, analysis.explanation, app.id]);

            rankedApplications.push({
                id: app.id,
                anonymized_id: app.anonymized_id,
                score: analysis.score,
                explanation: analysis.explanation
            });
        }

        // Sort by score (highest first)
        rankedApplications.sort((a, b) => b.score - a.score);

        // Log the ranking action
        await logAuditEvent(req.user.userId, 'AI_RANK', 'applications', null, { jobKey, applicationsCount: applications.length }, req.ip);

        res.json({
            success: true,
            rankedApplications,
            message: `${applications.length} applications ranked successfully`
        });

    } catch (error) {
        logger.error('AI ranking error:', error);
        res.status(500).json({ error: 'Failed to rank applications' });
    }
});

// Update application status (accept/reject)
app.put('/api/applications/:id/status', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, notes } = req.body;

        if (!['accepted', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Status must be either "accepted" or "rejected"' });
        }

        // Get application details
        const appResult = await pool.query(`
            SELECT a.*, j.title as job_title 
            FROM applications a
            JOIN job_descriptions j ON a.job_key = j.job_key
            WHERE a.id = $1
        `, [id]);

        if (appResult.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        const application = appResult.rows[0];

        // Update application status
        await pool.query(`
            UPDATE applications 
            SET status = $1, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $2
            WHERE id = $3
        `, [status, req.user.userId, id]);

        // Send email notification
        await sendStatusEmail(application, status);

        // Log the decision
        await logAuditEvent(req.user.userId, status.toUpperCase(), 'application', id, { notes, anonymized_id: application.anonymized_id }, req.ip);

        res.json({
            success: true,
            message: `Application ${status} successfully`,
            applicationId: id,
            status: status
        });

    } catch (error) {
        logger.error('Status update error:', error);
        res.status(500).json({ error: 'Failed to update application status' });
    }
});

// Statistics endpoint
app.get('/api/statistics', authenticateToken, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_applications,
                COUNT(*) FILTER (WHERE status = 'pending') as pending_applications,
                COUNT(*) FILTER (WHERE status = 'accepted') as accepted_applications,
                COUNT(*) FILTER (WHERE status = 'rejected') as rejected_applications,
                AVG(ai_score) FILTER (WHERE ai_score IS NOT NULL) as average_score
            FROM applications
        `);

        res.json(stats.rows[0]);
    } catch (error) {
        logger.error('Statistics error:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Helper Functions

async function extractCVContent(fileBuffer, fileName) {
    // Simulated AI CV extraction - in production, use Google Document AI or similar
    const skillSets = [
        ['JavaScript', 'React', 'Node.js', 'SQL', 'Git', 'CSS'],
        ['Python', 'Django', 'PostgreSQL', 'Docker', 'AWS', 'Linux'],
        ['Java', 'Spring Boot', 'Microservices', 'Kubernetes', 'Jenkins', 'Maven'],
        ['Data Science', 'Machine Learning', 'Python', 'TensorFlow', 'Pandas', 'SQL'],
        ['Product Management', 'Agile', 'User Research', 'Analytics', 'Leadership', 'Strategy']
    ];

    // Simple content analysis based on filename and random selection
    let selectedSkills = skillSets[Math.floor(Math.random() * skillSets.length)];
    const experience = Math.floor(Math.random() * 8) + 2;
    
    // Add some variation based on filename
    if (fileName.toLowerCase().includes('senior')) {
        selectedSkills = [...selectedSkills, 'Leadership', 'Mentoring', 'Architecture'];
    }

    return {
        name: '[REDACTED FOR BIAS PREVENTION]',
        email: '[CONTACT INFO HIDDEN UNTIL DECISION]',
        skills: selectedSkills,
        experience: `${experience} years`,
        education: experience > 5 ? 'Master\'s degree' : 'Bachelor\'s degree',
        achievements: [
            'Led successful project implementations',
            'Improved system performance by 30%',
            'Collaborated with cross-functional teams',
            'Mentored junior team members'
        ],
        extractedAt: new Date().toISOString()
    };
}

async function analyzeApplication(cvContent, jobDescription) {
    const cv = typeof cvContent === 'string' ? JSON.parse(cvContent) : cvContent;
    
    let totalScore = 0;
    let explanationPoints = [];
    let dimensionScores = {};

    // 1. EXPERIENCE RELEVANCE (25 points)
    const experienceScore = evaluateExperience(cv, jobDescription);
    dimensionScores.experience = experienceScore;
    totalScore += experienceScore;
    
    if (experienceScore >= 20) {
        explanationPoints.push(`✓ Excellent relevant experience: ${cv.experience} with strong background in required areas`);
    } else if (experienceScore >= 15) {
        explanationPoints.push(`✓ Good experience level with some relevant background`);
