FROM node:18-alpine

# Install build tools needed for native npm packages
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "run.js"]