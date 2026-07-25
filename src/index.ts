import { Container, type StopParams } from "@cloudflare/containers";
import type { OneOf } from "@chiballc/types";

export interface D1EnvVariables {
  BAO_D1_ACCOUNT_ID: string;
  BAO_D1_DATABASE_ID: string;
  BAO_D1_TOKEN: string;
}

export interface D1EnvUrl {
  BAO_D1_CONNECTION_URL: string;
}

function ensureD1Variables<T extends OneOf<[D1EnvUrl, D1EnvVariables]>>(
  env: Record<string, any>,
): asserts env is T {
  if (typeof env != "object") {
    throw new Error("Passed env is not an object", { cause: env });
  }

  if (env.BAO_D1_ACCOUNT_ID && env.BAO_D1_DATABASE_ID && env.BAO_D1_TOKEN) {
    return;
  }

  // Format: https://<AccountID>:<APIToken>@<DatabaseID>
  if (env.BAO_D1_CONNECTION_URL) {
    return;
  }

  throw new Error("We could not find the variables to access openbao", {
    cause: env,
  });
}

export class BaoContainer extends Container {
  defaultPort = 8200; // Port the container is listening on
  sleepAfter = "4m"; // Stop the instance if requests not sent for 10 minutes

  constructor(ctx: DurableObjectState<{}>, env: Cloudflare.Env) {
    if (!env.BAO_STATIC_SEAL_KEY) {
      throw new Error(
        "You need to set a BAO_STATIC_SEAL_KEY environment variable",
      );
    }

    ensureD1Variables(env);

    super(ctx, env);
    this.envVars = {
      BAO_D1_CONNECTION_URL: env.BAO_D1_CONNECTION_URL || "",
      BAO_STATIC_SEAL_KEY: env.BAO_STATIC_SEAL_KEY, // The driver uses this for static unsealing
      BAO_D1_ACCOUNT_ID: env.BAO_D1_ACCOUNT_ID || "",
      BAO_D1_DATABASE_ID: env.BAO_D1_DATABASE_ID || "",
      BAO_D1_TOKEN: env.BAO_D1_TOKEN || "",
      BAO_ADDR: "http://0.0.0.0:8200",
      SKIP_SETCAP: "true",
    };
  }

  override onStart() {
    console.log("OpenBao container successfully started");
    super.onStart();
  }

  override onStop(params: StopParams) {
    console.log("OpenBao container successfully shut down", params);
    super.onStop(params);
  }

  override onError(error: unknown) {
    console.log("OpenBao container error:", error);
    super.onError(error);
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, _: ExecutionContext) {
    const container = env.BAO_CONTAINER.getByName("BAO_CONTAINER", {
      routingMode: "primary-only",
    });
    return container.fetch(request);
  },
};
