import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  register(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Get(':username')
  async getProfile(@Param('username') username: string) {
    const user = await this.usersService.findByUsername(username);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    return {
      name: user.name,
      username: user.username,
    };
  }
}
