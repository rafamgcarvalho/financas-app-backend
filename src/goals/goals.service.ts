import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { CreateGoalsDto } from './dto/create-goals';
import { db } from '../db/drizzle';
import { and, eq, desc, or } from 'drizzle-orm';
import { goals, goalMembers, users } from 'src/db/schema';
import { randomUUID } from 'crypto';
import { UsersService } from '../users/users.service';

@Injectable()
export class GoalsService {
  constructor(private readonly usersService: UsersService) {}

  /* Cria uma meta */
  async create(dto: CreateGoalsDto, userId: string) {
    const goalId = randomUUID();

    const [newGoal] = await db
      .insert(goals)
      .values({
        id: goalId,
        userId,
        title: dto.title,
        description: dto.description,
        targetValue: dto.targetValue.toString(),
        currentValue: '0',
        startDate: new Date(dto.startDate),
        targetDate: dto.targetDate ? new Date(dto.targetDate) : null,
        type: dto.type,
        status: dto.status,
        priority: dto.priority,
      })
      .returning();

    // Adiciona o criador como OWNER na tabela de membros
    await db.insert(goalMembers).values({
      id: randomUUID(),
      goalId,
      userId,
      role: 'OWNER',
    });

    return { ...newGoal, members: [{ userId, role: 'OWNER' }], isOwner: true };
  }

  /* Retorna todas as metas onde o usuário é membro (owner ou member) */
  async getAll(userId: string) {
    // Busca todos os goalIds que o usuário participa
    const memberships = await db
      .select({ goalId: goalMembers.goalId, role: goalMembers.role })
      .from(goalMembers)
      .where(eq(goalMembers.userId, userId));

    if (memberships.length === 0) return [];

    const goalIds = memberships.map((m) => m.goalId);
    const roleMap = new Map(memberships.map((m) => [m.goalId, m.role]));

    // Busca as metas
    const allGoals = await db
      .select()
      .from(goals)
      .where(
        or(...goalIds.map((id) => eq(goals.id, id))),
      )
      .orderBy(desc(goals.createdAt));

    // Busca todos os membros de todas essas metas de uma vez
    const allMembers = await db
      .select({
        id: goalMembers.id,
        goalId: goalMembers.goalId,
        userId: goalMembers.userId,
        role: goalMembers.role,
        joinedAt: goalMembers.joinedAt,
        userName: users.name,
        userUsername: users.username,
      })
      .from(goalMembers)
      .innerJoin(users, eq(goalMembers.userId, users.id))
      .where(
        or(...goalIds.map((id) => eq(goalMembers.goalId, id))),
      );

    // Agrupa membros por goalId
    const membersByGoal = new Map<string, typeof allMembers>();
    for (const member of allMembers) {
      const list = membersByGoal.get(member.goalId) || [];
      list.push(member);
      membersByGoal.set(member.goalId, list);
    }

    return allGoals.map((goal) => ({
      ...goal,
      isOwner: roleMap.get(goal.id) === 'OWNER',
      members: (membersByGoal.get(goal.id) || []).map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.userName,
        username: m.userUsername,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
    }));
  }

  async getOne(id: string, userId: string) {
    // Verifica se o usuário é membro desta meta
    const [membership] = await db
      .select()
      .from(goalMembers)
      .where(and(eq(goalMembers.goalId, id), eq(goalMembers.userId, userId)));

    if (!membership) {
      throw new NotFoundException('Meta não encontrada');
    }

    const [goal] = await db.select().from(goals).where(eq(goals.id, id));

    if (!goal) {
      throw new NotFoundException('Meta não encontrada');
    }

    // Busca membros
    const members = await db
      .select({
        id: goalMembers.id,
        userId: goalMembers.userId,
        role: goalMembers.role,
        joinedAt: goalMembers.joinedAt,
        name: users.name,
        username: users.username,
      })
      .from(goalMembers)
      .innerJoin(users, eq(goalMembers.userId, users.id))
      .where(eq(goalMembers.goalId, id));

    return {
      ...goal,
      isOwner: membership.role === 'OWNER',
      members,
    };
  }

  async update(id: string, userId: string, dto: Partial<CreateGoalsDto>) {
    // Apenas o OWNER pode editar
    await this.assertOwner(id, userId);

    const { targetValue, startDate, targetDate, ...rest } = dto;

    const updateData = {
      ...rest,
      ...(targetValue !== undefined && { targetValue: targetValue.toString() }),

      ...(startDate && { startDate: new Date(startDate) }),
      ...(targetDate && { targetDate: new Date(targetDate) }),

      updatedAt: new Date(),
    };

    const [updated] = await db
      .update(goals)
      .set(updateData)
      .where(eq(goals.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundException('Meta não encontrada');
    }

    return updated;
  }

  async remove(id: string, userId: string) {
    // Apenas o OWNER pode excluir
    await this.assertOwner(id, userId);

    const [deleted] = await db
      .delete(goals)
      .where(eq(goals.id, id))
      .returning();

    return deleted;
  }

  /* ========== MEMBROS ========== */

  async addMember(goalId: string, ownerUserId: string, memberUsername: string) {
    // Apenas o OWNER pode adicionar membros
    await this.assertOwner(goalId, ownerUserId);

    // Busca o usuário pelo username
    const memberUser = await this.usersService.findByUsername(memberUsername);
    if (!memberUser) {
      throw new NotFoundException('Usuário não encontrado');
    }

    // Não pode adicionar a si mesmo (já é owner)
    if (memberUser.id === ownerUserId) {
      throw new ConflictException('Você já é membro desta meta');
    }

    // Verifica se já é membro
    const [existing] = await db
      .select()
      .from(goalMembers)
      .where(
        and(
          eq(goalMembers.goalId, goalId),
          eq(goalMembers.userId, memberUser.id),
        ),
      );

    if (existing) {
      throw new ConflictException('Este usuário já é membro desta meta');
    }

    const [newMember] = await db
      .insert(goalMembers)
      .values({
        id: randomUUID(),
        goalId,
        userId: memberUser.id,
        role: 'MEMBER',
      })
      .returning();

    return {
      ...newMember,
      name: memberUser.name,
      username: memberUser.username,
    };
  }

  async removeMember(
    goalId: string,
    ownerUserId: string,
    memberId: string,
  ) {
    // Apenas o OWNER pode remover membros
    await this.assertOwner(goalId, ownerUserId);

    // Busca o membro
    const [member] = await db
      .select()
      .from(goalMembers)
      .where(and(eq(goalMembers.id, memberId), eq(goalMembers.goalId, goalId)));

    if (!member) {
      throw new NotFoundException('Membro não encontrado');
    }

    // Não pode remover o OWNER
    if (member.role === 'OWNER') {
      throw new ForbiddenException('Não é possível remover o dono da meta');
    }

    const [deleted] = await db
      .delete(goalMembers)
      .where(eq(goalMembers.id, memberId))
      .returning();

    return deleted;
  }

  async getMembers(goalId: string, userId: string) {
    // Verifica se o usuário é membro
    const [membership] = await db
      .select()
      .from(goalMembers)
      .where(and(eq(goalMembers.goalId, goalId), eq(goalMembers.userId, userId)));

    if (!membership) {
      throw new NotFoundException('Meta não encontrada');
    }

    return await db
      .select({
        id: goalMembers.id,
        userId: goalMembers.userId,
        role: goalMembers.role,
        joinedAt: goalMembers.joinedAt,
        name: users.name,
        username: users.username,
      })
      .from(goalMembers)
      .innerJoin(users, eq(goalMembers.userId, users.id))
      .where(eq(goalMembers.goalId, goalId));
  }

  /* ========== HELPERS ========== */

  private async assertOwner(goalId: string, userId: string) {
    const [membership] = await db
      .select()
      .from(goalMembers)
      .where(
        and(
          eq(goalMembers.goalId, goalId),
          eq(goalMembers.userId, userId),
          eq(goalMembers.role, 'OWNER'),
        ),
      );

    if (!membership) {
      throw new ForbiddenException(
        'Apenas o dono da meta pode realizar esta ação',
      );
    }

    return membership;
  }
}
