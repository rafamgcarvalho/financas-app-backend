import { Test, TestingModule } from '@nestjs/testing';
import { GoalsService } from './goals.service';
import { UsersService } from '../users/users.service';

describe('GoalsService', () => {
  let service: GoalsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GoalsService, { provide: UsersService, useValue: {} }],
    }).compile();

    service = module.get<GoalsService>(GoalsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
