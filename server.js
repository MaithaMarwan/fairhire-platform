// server.js - FairHire Recruitment Platform Backend

// [.. All previously included code remains unchanged up to where it cut off ..]

    } else if (experienceScore >= 15) {
        explanationPoints.push(`✓ Good experience level with some relevant background`);
    } else {
        explanationPoints.push(`⚠️ Limited relevant experience detected`);
    }

    // 2. SKILLS MATCH (40 points)
    const requiredSkills = jobDescription.requirements || [];
    const applicantSkills = cv.skills || [];

    const matchedSkills = requiredSkills.filter(req =>
        applicantSkills.some(app => app.toLowerCase().includes(req.toLowerCase()))
    );

    const skillsScore = Math.min(40, matchedSkills.length * 8);
    dimensionScores.skills = skillsScore;
    totalScore += skillsScore;

    if (matchedSkills.length > 0) {
        explanationPoints.push(`✓ ${matchedSkills.length} matching skill(s): ${matchedSkills.join(', ')}`);
    } else {
        explanationPoints.push(`⚠️ No matching skills found`);
    }

    // 3. EDUCATION LEVEL (15 points)
    let educationScore = 0;
    if (cv.education?.toLowerCase().includes("master")) {
        educationScore = 15;
        explanationPoints.push("✓ Holds a Master's degree");
    } else if (cv.education?.toLowerCase().includes("bachelor")) {
        educationScore = 10;
        explanationPoints.push("✓ Holds a Bachelor's degree");
    } else {
        explanationPoints.push("⚠️ Education level not clearly specified");
    }
    dimensionScores.education = educationScore;
    totalScore += educationScore;

    // 4. ACHIEVEMENTS (20 points)
    const achievements = cv.achievements || [];
    const achievementsScore = Math.min(20, achievements.length * 4);
    dimensionScores.achievements = achievementsScore;
    totalScore += achievementsScore;

    if (achievements.length > 0) {
        explanationPoints.push(`✓ ${achievements.length} notable achievement(s)`);
    } else {
        explanationPoints.push(`⚠️ No achievements mentioned`);
    }

    const finalExplanation = explanationPoints.join('\n');

    return {
        score: totalScore,
        explanation: finalExplanation
    };
}

function evaluateExperience(cv, jobDescription) {
    const yearsMatch = cv.experience?.match(/(\d+)/);
    const years = yearsMatch ? parseInt(yearsMatch[1]) : 0;

    if (years >= 6) return 25;
    if (years >= 4) return 20;
    if (years >= 2) return 15;
    return 10;
}

async function sendConfirmationEmail(toEmail, jobTitle, appId) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: toEmail,
        subject: `Application Received: ${jobTitle}`,
        text: `Thank you for applying for ${jobTitle}.\n\nYour Application ID: ${appId}.\n\nWe appreciate your interest and will get back to you soon.\n\n- FairHire Team`
    };

    await emailTransporter.sendMail(mailOptions);
}

async function sendStatusEmail(application, status) {
    const subject = status === 'accepted' ? 'Congratulations! You've been selected' : 'Application Status Update';
    const body = status === 'accepted'
        ? `Dear applicant,\n\nCongratulations! Your application for ${application.job_title} has been accepted.\n\nWe will contact you with next steps shortly.`
        : `Dear applicant,\n\nThank you for your application for ${application.job_title}.\n\nWe regret to inform you that you were not selected at this time.`;

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: application.email,
        subject,
        text: body
    };

    await emailTransporter.sendMail(mailOptions);
}

async function logAuditEvent(userId, action, resourceType, resourceId, details, ip) {
    try {
        await pool.query(`
            INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, ip_address)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [userId, action, resourceType, resourceId, details, ip]);
    } catch (error) {
        logger.warn('Audit logging failed:', error.message);
    }
}

initializeDatabase().then(() => {
    app.listen(PORT, () => {
        logger.info(`🚀 Server is running on port ${PORT}`);
    });
}).catch(err => {
    logger.error('❌ Failed to initialize database. Server not started.');
});

