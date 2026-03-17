import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * Department Guard — Restricts directors to their own department.
 *
 * Usage: Apply to endpoints that filter by department_id.
 * Directors can only access data where department_id matches their own.
 * admin_rh and executive roles bypass this restriction.
 *
 * The guard checks for department_id in:
 * 1. Route params (:departmentId)
 * 2. Query params (?department_id=...)
 * 3. Request body ({ department_id: ... })
 */
@Injectable()
export class DepartmentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUser;

    if (!user) return false;

    // admin_rh and executive can access all departments
    if (user.role === 'admin_rh' || user.role === 'executive') {
      return true;
    }

    // For directors: verify the requested department matches their own
    if (user.role === 'director') {
      const requestedDeptId =
        request.params?.departmentId ||
        request.query?.department_id ||
        request.body?.department_id;

      // If no department filter specified, the service layer should
      // automatically scope to the user's department
      if (!requestedDeptId) {
        return true;
      }

      if (requestedDeptId !== user.department_id) {
        throw new ForbiddenException(
          'Solo puedes acceder a datos de tu propia área',
        );
      }

      return true;
    }

    // Collaborators pass through (their access is scoped by user_id, not department)
    return true;
  }
}
