FROM node:buster-slim
RUN apt-get update && apt-get install -y ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE ${PORT}
CMD [ "node", "dist/index.js" ]