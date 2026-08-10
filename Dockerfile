# --- Stage 1: Build the UI ---
FROM node:20-alpine AS ui-builder

COPY .ciao-repo /src

WORKDIR /src/ui
RUN corepack enable && pnpm install && pnpm build

# --- Stage 2: Build the Binary ---
FROM golang:1.25-alpine AS binary-builder
COPY --from=ui-builder /src /src
WORKDIR /src
RUN apk add --no-cache make git bash
# Compiles the binary with UI assets embedded. The fork can contain newly
# added dependencies before their checksums have been committed upstream, so
# permit Go to populate go.sum in this disposable build stage.
RUN GOFLAGS=-mod=mod make bin

# --- Stage 3: Final Production Image ---
FROM alpine:latest
RUN apk add --no-cache libcap

COPY --from=binary-builder /src/bin/bao /bin/bao

# Ensure the binary is executable
RUN chmod +x /bin/bao

# Copy the configuration file
COPY config/ /etc/bao/

EXPOSE 8200

# Start with the config file
ENTRYPOINT ["/bin/bao"]
CMD ["server", "-config=/etc/bao/config.hcl"]
