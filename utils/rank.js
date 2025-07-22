// Dummy AI ranking logic
const { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);

async function rankCVs(cvs, jobDesc) {
  const results = [];

  for (let cv of cvs) {
    const response = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are an AI that screens resumes fairly. Hide names/nationalities and give a brief ranking explanation." },
        { role: "user", content: `Job: ${jobDesc}\nCV:\n${cv.content}` }
      ]
    });

    results.push({
      ...cv,
      explanation: response.data.choices[0].message.content,
      email: extractEmail(cv.content)
    });
  }

  // Sort descending by explanation score (optional mock)
  return results.sort((a, b) => b.explanation.length - a.explanation.length);
}

function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : "unknown@example.com";
}

module.exports = { rankCVs };
