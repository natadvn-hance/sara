# microsocks (tech radar), built from a pinned commit: a tiny SOCKS5 server.
# The Docker network it sits on decides the outgoing IP (compose.prod.yml, egress-ip1).
FROM alpine:3.20 AS build
RUN apk add --no-cache build-base git
RUN git clone https://github.com/rofl0r/microsocks /src \
 && cd /src && git checkout 98421a21c4adc4c77c0cf3a5d650cc28ad3e0107 && make

FROM alpine:3.20
COPY --from=build /src/microsocks /usr/local/bin/microsocks
EXPOSE 1080
CMD ["microsocks", "-p", "1080"]
