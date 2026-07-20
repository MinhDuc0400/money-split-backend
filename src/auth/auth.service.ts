import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

import { GoogleUser } from './interfaces/google-user.interface';
import { AppleUser } from './interfaces/apple-user.interface';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { email, password, name } = registerDto;

    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate avatar URL using DiceBear API (same as frontend)
    const avatarUrl = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(email)}`;

    // Create user
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        avatarUrl,
      },
    });

    // Generate JWT token
    const token = this.generateToken(
      user.id,
      user.email,
      user.name,
      user.avatarUrl,
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      token,
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    // Find user
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate JWT token
    const token = this.generateToken(
      user.id,
      user.email,
      user.name,
      user.avatarUrl,
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      token,
    };
  }

  private generateToken(
    userId: string,
    email: string,
    name: string,
    picture?: string | null,
  ): string {
    const payload = {
      sub: userId,
      email,
      name,
      picture: picture || null,
    };
    return this.jwtService.sign(payload);
  }

  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
      },
    });
    return user;
  }

  async validateGoogleUser(googleUser: GoogleUser) {
    const { email, googleId, firstName, lastName, picture } = googleUser;

    let user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (user) {
      // If user exists but doesn't have googleId, link it
      if (!user.googleId) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { googleId },
        });
      }
    } else {
      // Create new user
      user = await this.prisma.user.create({
        data: {
          email,
          googleId,
          name: `${firstName} ${lastName}`.trim(),
          avatarUrl: picture,
        },
      });
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      token: this.generateToken(user.id, user.email, user.name, user.avatarUrl),
    };
  }

  async validateAppleUser(appleUser: AppleUser) {
    const { appleId, email, firstName, lastName } = appleUser;

    // Try to find by appleId first
    let user = await this.prisma.user.findUnique({
      where: { appleId },
    });

    if (!user && email) {
      // Fall back to email lookup (link existing account)
      user = await this.prisma.user.findUnique({ where: { email } });
      if (user && !user.appleId) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { appleId },
        });
      }
    }

    if (!user) {
      // Create new user — Apple may not provide email on subsequent logins
      const name =
        [firstName, lastName].filter(Boolean).join(' ') || 'Apple User';
      const avatarUrl = email
        ? `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(email)}`
        : `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(appleId)}`;
      user = await this.prisma.user.create({
        data: {
          email: email || `${appleId}@apple.privaterelay.appleid.com`,
          appleId,
          name,
          avatarUrl,
        },
      });
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      token: this.generateToken(user.id, user.email, user.name, user.avatarUrl),
    };
  }
}
