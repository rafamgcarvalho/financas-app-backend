import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsService } from './transactions.service';
import { GoalsGateway } from '../goals/goals.gateway';

describe('TransactionsService', () => {
  let service: TransactionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: GoalsGateway, useValue: { notifyGoalUpdated: jest.fn() } },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
