import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-apple';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { AppleUser } from '../interfaces/apple-user.interface';

@Injectable()
export class AppleStrategy extends PassportStrategy(Strategy, 'apple') {
  constructor(
    configService: ConfigService,
    private authService: AuthService,
  ) {
    super({
      clientID: configService.get<string>('APPLE_CLIENT_ID') || 'DISABLED',
      teamID: configService.get<string>('APPLE_TEAM_ID') || 'DISABLED',
      keyID: configService.get<string>('APPLE_KEY_ID') || 'DISABLED',
      privateKeyString: configService.get<string>('APPLE_PRIVATE_KEY') || '',
      callbackURL:
        configService.get<string>('APPLE_CALLBACK_URL') ||
        'http://localhost:3000/auth/apple/callback',
      scope: ['name', 'email'],
      passReqToCallback: false,
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    idToken: any,
    profile: any,
  ): Promise<any> {
    // Apple sends user info only on first login via the `user` field in profile
    const appleUser: AppleUser = {
      appleId: idToken.sub,
      email: idToken.email || null,
      firstName: profile?.name?.firstName || null,
      lastName: profile?.name?.lastName || null,
    };

    return this.authService.validateAppleUser(appleUser);
  }
}
