# Use a lightweight Python image
FROM python:3.11-slim

# Set the working directory
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install system dependencies (needed for some auth/crypto libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
# Ensure you have a requirements.txt with flask, requests, python-dotenv, flask-login, and authlib
RUN pip install --no-cache-dir flask requests python-dotenv flask-login authlib

# Copy the rest of your soccer app code
COPY . .

ENV FLASK_APP=backend/main.py

EXPOSE 8000

# Start the application
CMD ["flask", "run", "--host=0.0.0.0", "--port=8000"]