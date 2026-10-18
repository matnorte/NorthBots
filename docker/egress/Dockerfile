FROM node:22-alpine
WORKDIR /app
RUN npm install --no-audit --no-fund pg@8.13.1
COPY docker/egress/proxy.mjs ./
USER node
EXPOSE 3128
CMD ["node", "proxy.mjs"]
