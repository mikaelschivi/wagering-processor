import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type Principal, ProviderIdentityPort } from "../../application/ports";
import { ForbiddenProviderError } from "../../domain/errors";

type Access = "public" | "provider" | "admin";

const ROUTE_ACCESS = "route-access";
const tag = (access: Access) => () => SetMetadata(ROUTE_ACCESS, access);

export const Public = tag("public");
export const ProviderRoute = tag("provider");
export const AdminRoute = tag("admin");

export const routeAccess = (target: object): Access | undefined => Reflect.getMetadata(ROUTE_ACCESS, target);

export class AnonymousDevIdentity extends ProviderIdentityPort {
  resolve(): Principal {
    return { kind: "anonymous-dev" };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: ProviderIdentityPort,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ROUTE_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!access) throw new Error(`route ${context.getClass().name}.${context.getHandler().name} has no access tag`);
    if (access === "public") return true;

    const request = context.switchToHttp().getRequest();
    const principal = this.identity.resolve(request);
    if (access === "admin" && principal.kind === "provider") {
      throw new ForbiddenProviderError("this route is for administrators");
    }
    request.principal = principal;
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => context.switchToHttp().getRequest().principal,
);
