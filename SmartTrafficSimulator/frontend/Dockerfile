FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ARG NEXT_PUBLIC_TRAFFIC_WS_URL=ws://localhost:8000/ws/traffic
ARG NEXT_PUBLIC_TRAFFIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_TRAFFIC_WS_URL=$NEXT_PUBLIC_TRAFFIC_WS_URL
ENV NEXT_PUBLIC_TRAFFIC_API_URL=$NEXT_PUBLIC_TRAFFIC_API_URL

RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
