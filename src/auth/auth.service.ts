import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service'; // Importe o seu service
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);

    if (!user) {
      throw new UnauthorizedException('Email ou senha inválidos');
    }

    // 2. Compara a senha
    const passwordValid = await bcrypt.compare(dto.password, user.password);

    if (!passwordValid) {
      throw new UnauthorizedException('Email ou senha inválidos');
    }

    // 3. Gera o payload (dados que vão dentro do token)
    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
    };

    // 4. Retorna o token + dados básicos
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      access_token: await this.jwtService.signAsync(payload),
    };
  }
}
