FROM node:20-alpine

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production and dev dependencies
RUN npm install

# Copy application source
COPY . .

# Run build and test validation
RUN npm run build
RUN NODE_ENV=test npm test

# Expose server port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Start server
CMD ["npm", "start"]
