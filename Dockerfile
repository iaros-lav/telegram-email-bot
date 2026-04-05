FROM node:22-alpine

WORKDIR /app

COPY package.json ./package.json
COPY src ./src
COPY data ./data

ENV NODE_ENV=production
ENV DASHBOARD_ENABLED=true
ENV DASHBOARD_HOST=0.0.0.0
ENV DASHBOARD_PORT=3000

EXPOSE 3000

CMD ["node", "src/index.js"]
