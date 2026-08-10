# --- Stage 1: Build the UI ---
FROM node:20-alpine AS ui-builder

COPY .ciao-repo /src

WORKDIR /src/ui
RUN set -eu; \
    printf '%s\n' 'nameserver 1.1.1.1' 'nameserver 1.0.0.1' > /etc/resolv.conf; \
    corepack enable; \
    attempts=0; \
    until corepack prepare pnpm@10.33.0 --activate; do \
        attempts=$((attempts + 1)); \
        if [ "$attempts" -ge 5 ]; then exit 1; fi; \
        sleep $((attempts * 2)); \
    done; \
    pnpm install --frozen-lockfile \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=2000 \
        --fetch-retry-maxtimeout=20000; \
    pnpm build

# --- Stage 2: Build the Binary ---
FROM golang:1.25 AS binary-builder
COPY --from=ui-builder /src /src
WORKDIR /src
# Compiles the binary with UI assets embedded. The fork can contain newly
# added dependencies before their checksums have been committed upstream, so
# permit Go to populate go.sum in this disposable build stage.
RUN printf '%s\n' 'nameserver 1.1.1.1' 'nameserver 1.0.0.1' > /etc/resolv.conf && \
    GOFLAGS=-mod=mod make bin

# --- Stage 3: Final Production Image ---
FROM alpine:latest

COPY --from=binary-builder /src/bin/bao /bin/bao

# Ensure the binary is executable
RUN chmod +x /bin/bao

# Copy the configuration file
COPY config/ /etc/bao/

EXPOSE 8200

# Start with the config file
ENTRYPOINT ["/bin/bao"]
CMD ["server", "-config=/etc/bao/config.hcl"]
