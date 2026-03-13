# PitchPulse Soccer App

## Getting Started

### Prerequisites
- Docker
- Docker Compose

### Setup
1. Clone the repository:
	```
	git clone <repo-url>
	cd <repo-folder>
	```
2. Ensure your `.env` file is present in the project root with required secrets (API keys, OAuth credentials).
3. Build and start the containers:
	```
	docker compose up --build

4. Register for n8n
5. Create a new workflow and paste the n8n-worklof.json into it
6. Set up Gemini API credentials with an API key
7. Set up Generic Header Authentication Credentials for HTTP Request Tools with name=x-api-key

### Access
- Flask app: [http://localhost:8000]
- n8n workflow editor: [http://localhost:5678]

### Troubleshooting
- If you see port errors, make sure ports 8000 and 5678 are free.

### Stopping
To stop the containers:
```
docker compose down
```

---
For development, use VS Code Dev Containers for an integrated environment.

