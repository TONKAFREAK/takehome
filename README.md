## Setup

```bash
npm install
```

Create a `.env` file:

```
AI_API_KEY=your-openrouter-api-key
AI_API_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=google/gemini-2.5-flash-lite
AI_EMBED_MODEL=openai/text-embedding-3-small
```

## Run

```bash
# Full run
npm run start

# Without AI
npm run noai
```

Output goes to `output/results.html`.
